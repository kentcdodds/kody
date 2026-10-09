/**
 * soft-delete-read-filter: opt-out
 *
 * Offboarding soft-deletes memberships/grants and reads soft-deleted rows while
 * applying job dispositions. Live listing paths stay filtered elsewhere.
 */

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	listUserOAuthGrants,
	revokeOAuthGrant,
	type OAuthGrantHelpers,
	type OAuthGrantListItem,
} from '#worker/oauth-grants.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { syncJobManagerAlarm } from '#worker/jobs/manager-client.ts'

export type OffboardingJobDisposition = 'cancel' | 'delete' | 'keep_running'

export type OffboardingJobChoice = {
	jobId: string
	disposition: OffboardingJobDisposition
}

export type OffboardingResult = {
	membershipSoftDeleted: boolean
	teamMembershipsSoftDeleted: number
	grantsSoftDeleted: number
	budgetsSoftDeleted: number
	accessEpochBumped: boolean
	revokedOAuthGrants: number
	revokedApiTokens: number
	revokedCliBootstrapCodes: number
	disconnectedIntegrations: Array<string>
	disconnectedMcpServers: Array<string>
	jobDispositions: Array<OffboardingJobChoice>
}

export type OffboardingPreview = {
	jobs: Array<{ id: string; name: string }>
	ownLoginIntegrations: Array<string>
	ownLoginMcpServers: Array<string>
}

function jobCreatedByUserId(row: {
	user_id: string
	created_by_user_id?: string | null
}): string {
	const createdBy = row.created_by_user_id
	if (typeof createdBy === 'string' && createdBy.trim().length > 0) {
		return createdBy
	}
	return row.user_id
}

async function listMemberCreatedJobs(input: {
	env: Env
	orgId: string
	memberUserId: string
}): Promise<Array<{ id: string; name: string }>> {
	const jobsStore = jobsData(input.env)
	const allJobs = await jobsStore.listJobsForUser({ userId: input.orgId })
	return allJobs
		.filter(
			(row) =>
				jobCreatedByUserId({
					user_id: row.user_id,
					created_by_user_id: row.created_by_user_id,
				}) === input.memberUserId,
		)
		.map((row) => ({ id: row.id, name: row.name }))
}

function oauthGrantOrgId(
	grant: OAuthGrantListItem,
	memberUserId: string,
): string {
	const metadata = grant.metadata
	if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
		const orgId = (metadata as Record<string, unknown>)['orgId']
		if (typeof orgId === 'string' && orgId.trim().length > 0) {
			return orgId.trim()
		}
	}
	// Interim dual path (Teams §6.1): grants without metadata.orgId are treated
	// as bound to the member's personal/migrated org id (= userId). Cleanup
	// issue: revoke leftover grants lacking orgId after soak, then delete this
	// fallback.
	return memberUserId
}

/**
 * Revoke MCP OAuth grants for `memberUserId` that are bound to `orgId`.
 * Fail-closed: throws if listing or any revoke fails.
 */
export async function revokeOAuthGrantsForOrg(input: {
	helpers: OAuthGrantHelpers
	memberUserId: string
	orgId: string
}): Promise<number> {
	const grants = await listUserOAuthGrants(input.helpers, input.memberUserId)
	const matches = grants.filter(
		(grant) => oauthGrantOrgId(grant, input.memberUserId) === input.orgId,
	)
	let revoked = 0
	for (const grant of matches) {
		await revokeOAuthGrant(input.helpers, grant.id, input.memberUserId)
		revoked += 1
	}
	return revoked
}

export async function previewMemberOffboarding(input: {
	appDb: D1Database
	env: Env
	orgId: string
	memberUserId: string
}): Promise<OffboardingPreview> {
	const jobs = await listMemberCreatedJobs({
		env: input.env,
		orgId: input.orgId,
		memberUserId: input.memberUserId,
	})

	const integrations = await input.appDb
		.prepare(
			`SELECT name FROM user_integrations
			 WHERE user_id = ? AND connected_by_user_id = ?${andLiveDeletedAtSql()}
			 ORDER BY name ASC`,
		)
		.bind(input.orgId, input.memberUserId)
		.all<{ name: string }>()

	const mcpServers = await input.appDb
		.prepare(
			`SELECT name FROM mcp_server_settings
			 WHERE user_id = ? AND connected_by_user_id = ?${andLiveDeletedAtSql()}
			 ORDER BY name ASC`,
		)
		.bind(input.orgId, input.memberUserId)
		.all<{ name: string }>()

	return {
		jobs,
		ownLoginIntegrations: (integrations.results ?? []).map((row) => row.name),
		ownLoginMcpServers: (mcpServers.results ?? []).map((row) => row.name),
	}
}

async function assertNotLastLiveOwner(input: {
	appDb: D1Database
	orgId: string
	memberUserId: string
}) {
	const membership = await input.appDb
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.orgId, input.memberUserId)
		.first<{ role: string }>()
	if (!membership) {
		throw new Error('member_not_found')
	}
	if (membership.role !== 'owner') return
	const otherOwners = await input.appDb
		.prepare(
			`SELECT COUNT(*) AS count FROM org_memberships
			 WHERE org_id = ? AND role = 'owner' AND user_id != ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.orgId, input.memberUserId)
		.first<{ count: number }>()
	if (Number(otherOwners?.count ?? 0) === 0) {
		throw new Error('cannot_remove_last_owner')
	}
}

async function softDeleteMembershipGraph(input: {
	appDb: D1Database
	orgId: string
	memberUserId: string
	nowIso: string
}): Promise<{
	membershipSoftDeleted: boolean
	teamMembershipsSoftDeleted: number
	grantsSoftDeleted: number
	budgetsSoftDeleted: number
	accessEpochBumped: boolean
}> {
	const membership = await input.appDb
		.prepare(
			`UPDATE org_memberships
			 SET deleted_at = ?
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.nowIso, input.orgId, input.memberUserId)
		.run()

	const teamMembers = await input.appDb
		.prepare(
			`UPDATE team_members
			 SET deleted_at = ?
			 WHERE user_id = ?
			   AND deleted_at IS NULL
			   AND team_id IN (
			     SELECT id FROM teams WHERE org_id = ?${andLiveDeletedAtSql()}
			   )`,
		)
		.bind(input.nowIso, input.memberUserId, input.orgId)
		.run()

	const grants = await input.appDb
		.prepare(
			`UPDATE grants
			 SET deleted_at = ?
			 WHERE org_id = ?
			   AND subject_type = 'user'
			   AND subject_id = ?
			   AND deleted_at IS NULL`,
		)
		.bind(input.nowIso, input.orgId, input.memberUserId)
		.run()

	const budgets = await input.appDb
		.prepare(
			`UPDATE org_user_budgets
			 SET deleted_at = ?
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.nowIso, input.orgId, input.memberUserId)
		.run()

	const epoch = await input.appDb
		.prepare(
			`UPDATE orgs
			 SET access_epoch = access_epoch + 1, updated_at = ?
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.nowIso, input.orgId)
		.run()

	return {
		membershipSoftDeleted: (membership.meta.changes ?? 0) > 0,
		teamMembershipsSoftDeleted: teamMembers.meta.changes ?? 0,
		grantsSoftDeleted: grants.meta.changes ?? 0,
		budgetsSoftDeleted: budgets.meta.changes ?? 0,
		accessEpochBumped: (epoch.meta.changes ?? 0) > 0,
	}
}

async function disconnectOwnLoginIntegrations(input: {
	appDb: D1Database
	orgId: string
	memberUserId: string
	nowIso: string
}): Promise<{
	disconnectedIntegrations: Array<string>
	disconnectedMcpServers: Array<string>
}> {
	const integrationRows = await input.appDb
		.prepare(
			`SELECT name FROM user_integrations
			 WHERE user_id = ? AND connected_by_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.orgId, input.memberUserId)
		.all<{ name: string }>()
	const disconnectedIntegrations = (integrationRows.results ?? []).map(
		(row) => row.name,
	)
	if (disconnectedIntegrations.length > 0) {
		await input.appDb
			.prepare(
				`UPDATE user_integrations
				 SET access_token_encrypted = NULL,
				     refresh_token_encrypted = NULL,
				     connected_at = NULL,
				     token_refreshed_at = NULL,
				     updated_at = ?
				 WHERE user_id = ?
				   AND connected_by_user_id = ?
				   AND deleted_at IS NULL`,
			)
			.bind(input.nowIso, input.orgId, input.memberUserId)
			.run()
	}

	const mcpRows = await input.appDb
		.prepare(
			`SELECT id, name FROM mcp_server_settings
			 WHERE user_id = ? AND connected_by_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.orgId, input.memberUserId)
		.all<{ id: string; name: string }>()
	const disconnectedMcpServers = (mcpRows.results ?? []).map((row) => row.name)
	if (disconnectedMcpServers.length > 0) {
		await input.appDb
			.prepare(
				`UPDATE mcp_server_settings
				 SET enabled = 0, updated_at = ?
				 WHERE user_id = ?
				   AND connected_by_user_id = ?
				   AND deleted_at IS NULL`,
			)
			.bind(input.nowIso, input.orgId, input.memberUserId)
			.run()
	}

	return { disconnectedIntegrations, disconnectedMcpServers }
}

async function revokeOrgBoundCredentials(input: {
	appDb: D1Database
	orgId: string
	memberUserId: string
	nowIso: string
	oauthHelpers: OAuthGrantHelpers | null
}): Promise<{
	revokedOAuthGrants: number
	revokedApiTokens: number
	revokedCliBootstrapCodes: number
}> {
	let revokedOAuthGrants = 0
	if (input.oauthHelpers) {
		revokedOAuthGrants = await revokeOAuthGrantsForOrg({
			helpers: input.oauthHelpers,
			memberUserId: input.memberUserId,
			orgId: input.orgId,
		})
	}

	// api_tokens.org_id / bootstrap org_id land in P4. Until then every token
	// is bound to the member's personal org (id = user id). Revoke only when
	// offboarding from that org; other-org revoke waits on P4 org_id.
	const revokeUserScopedCredentials = input.orgId === input.memberUserId
	let revokedApiTokens = 0
	let revokedCliBootstrapCodes = 0
	if (revokeUserScopedCredentials) {
		const tokenResult = await input.appDb
			.prepare(
				`UPDATE api_tokens
				 SET revoked_at = ?, updated_at = ?
				 WHERE user_id = ?
				   AND revoked_at IS NULL
				   AND deleted_at IS NULL`,
			)
			.bind(input.nowIso, input.nowIso, input.memberUserId)
			.run()
		revokedApiTokens = tokenResult.meta.changes ?? 0

		const bootstrap = await input.appDb
			.prepare(`DELETE FROM cli_credential_bootstrap_codes WHERE user_id = ?`)
			.bind(input.memberUserId)
			.run()
		revokedCliBootstrapCodes = bootstrap.meta.changes ?? 0
	}

	return {
		revokedOAuthGrants,
		revokedApiTokens,
		revokedCliBootstrapCodes,
	}
}

async function applyJobDispositions(input: {
	env: Env
	orgId: string
	memberUserId: string
	choices: Array<OffboardingJobChoice>
	nowIso: string
	memberLeftVoluntarily: boolean
}): Promise<Array<OffboardingJobChoice>> {
	if (input.memberLeftVoluntarily) {
		// Spec §9 step 4: when a member leaves on their own, jobs keep running.
		return []
	}
	const jobsStore = jobsData(input.env)
	const applied: Array<OffboardingJobChoice> = []
	for (const choice of input.choices) {
		const job = await jobsStore.getJobById({
			userId: input.orgId,
			jobId: choice.jobId,
		})
		if (!job) continue
		const createdBy = jobCreatedByUserId({
			user_id: job.user_id,
			created_by_user_id: job.created_by_user_id,
		})
		if (createdBy !== input.memberUserId) continue
		switch (choice.disposition) {
			case 'keep_running':
				applied.push(choice)
				break
			case 'cancel': {
				const updated = {
					...job.record,
					enabled: false,
					updatedAt: input.nowIso,
				}
				await jobsStore.updateJob({
					userId: input.orgId,
					job: updated,
					callerContextJson: job.callerContextJson,
				})
				applied.push(choice)
				break
			}
			case 'delete': {
				await jobsStore.deleteJob({
					userId: input.orgId,
					jobId: choice.jobId,
				})
				applied.push(choice)
				break
			}
			default: {
				const exhaustive: never = choice.disposition
				throw new Error(`Unhandled job disposition: ${String(exhaustive)}`)
			}
		}
	}
	await syncJobManagerAlarm({ env: input.env, userId: input.orgId })
	return applied
}

/**
 * Remove a member from an org (or complete leave): soft-delete access rows,
 * revoke org-bound credentials, disconnect own-login integrations, and apply
 * job dispositions when an Owner removes them.
 */
export async function offboardOrgMember(input: {
	appDb: D1Database
	env: Env
	orgId: string
	memberUserId: string
	/** When true, jobs keep running and Owners are expected to decide later. */
	memberLeftVoluntarily: boolean
	jobChoices?: Array<OffboardingJobChoice>
	oauthHelpers?: OAuthGrantHelpers | null
	now?: Date
}): Promise<OffboardingResult> {
	const nowIso = (input.now ?? new Date()).toISOString()
	await assertNotLastLiveOwner({
		appDb: input.appDb,
		orgId: input.orgId,
		memberUserId: input.memberUserId,
	})

	const graph = await softDeleteMembershipGraph({
		appDb: input.appDb,
		orgId: input.orgId,
		memberUserId: input.memberUserId,
		nowIso,
	})
	if (!graph.membershipSoftDeleted) {
		throw new Error('member_not_found')
	}

	const credentials = await revokeOrgBoundCredentials({
		appDb: input.appDb,
		orgId: input.orgId,
		memberUserId: input.memberUserId,
		nowIso,
		oauthHelpers: input.oauthHelpers ?? null,
	})

	const disconnected = await disconnectOwnLoginIntegrations({
		appDb: input.appDb,
		orgId: input.orgId,
		memberUserId: input.memberUserId,
		nowIso,
	})

	const jobDispositions = await applyJobDispositions({
		env: input.env,
		orgId: input.orgId,
		memberUserId: input.memberUserId,
		choices: input.jobChoices ?? [],
		nowIso,
		memberLeftVoluntarily: input.memberLeftVoluntarily,
	})

	return {
		...graph,
		...credentials,
		...disconnected,
		jobDispositions,
	}
}
