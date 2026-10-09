/**
 * soft-delete-read-filter: opt-out
 *
 * Soft-delete and restore must read and update tombstoned rows.
 */

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { isWithinSoftDeleteRestoreWindow } from '#worker/soft-delete/window.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { syncJobManagerAlarm } from '#worker/jobs/manager-client.ts'
import {
	orgOwnedUserIdRestoreTables,
	orgOwnedUserIdSoftDeleteTables,
} from '#worker/orgs/data-targets.ts'
import { onMemberSoftRemoved } from '#worker/orgs/member-offboarding.ts'

export class OrgRestoreWindowExpiredError extends Error {
	constructor() {
		super('restore_window_expired')
		this.name = 'OrgRestoreWindowExpiredError'
	}
}

export class UserDeleteBlockedSoleOwnerError extends Error {
	readonly blockers: Array<{ orgId: string; orgSlug: string }>
	constructor(blockers: Array<{ orgId: string; orgSlug: string }>) {
		const names = blockers.map((b) => `@${b.orgSlug}`).join(', ')
		super(`user_deletion_blocked_sole_owner:${names}`)
		this.name = 'UserDeleteBlockedSoleOwnerError'
		this.blockers = blockers
	}
}

export type SoftDeleteOrgResult = {
	orgId: string
	deletedAt: string
	resourceRowsSoftDeleted: number
	jobsSoftDeleted: number
}

async function softDeleteOrgOwnedAppRows(input: {
	appDb: D1Database
	orgId: string
	deletedAt: string
}): Promise<number> {
	let total = 0
	for (const table of orgOwnedUserIdSoftDeleteTables) {
		const result = await input.appDb
			.prepare(
				`UPDATE ${table}
				 SET deleted_at = ?
				 WHERE user_id = ? AND deleted_at IS NULL`,
			)
			.bind(input.deletedAt, input.orgId)
			.run()
		total += result.meta.changes ?? 0
	}
	for (const table of [
		'org_memberships',
		'teams',
		'grants',
		'org_user_budgets',
	] as const) {
		const result = await input.appDb
			.prepare(
				`UPDATE ${table}
				 SET deleted_at = ?
				 WHERE org_id = ? AND deleted_at IS NULL`,
			)
			.bind(input.deletedAt, input.orgId)
			.run()
		total += result.meta.changes ?? 0
	}
	const teamMembers = await input.appDb
		.prepare(
			`UPDATE team_members
			 SET deleted_at = ?
			 WHERE deleted_at IS NULL
			   AND team_id IN (SELECT id FROM teams WHERE org_id = ?)`,
		)
		.bind(input.deletedAt, input.orgId)
		.run()
	total += teamMembers.meta.changes ?? 0
	const listings = await input.appDb
		.prepare(
			`UPDATE community_listings
			 SET deleted_at = ?
			 WHERE owner_user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.deletedAt, input.orgId)
		.run()
	total += listings.meta.changes ?? 0
	return total
}

async function restoreOrgOwnedAppRows(input: {
	appDb: D1Database
	orgId: string
	deletedAt: string
}): Promise<number> {
	let total = 0
	for (const table of orgOwnedUserIdRestoreTables) {
		const result = await input.appDb
			.prepare(
				`UPDATE ${table}
				 SET deleted_at = NULL, deleting_at = NULL
				 WHERE user_id = ? AND deleted_at = ?`,
			)
			.bind(input.orgId, input.deletedAt)
			.run()
		total += result.meta.changes ?? 0
	}
	for (const table of [
		'org_memberships',
		'teams',
		'grants',
		'org_user_budgets',
	] as const) {
		const result = await input.appDb
			.prepare(
				`UPDATE ${table}
				 SET deleted_at = NULL
				 WHERE org_id = ? AND deleted_at = ?`,
			)
			.bind(input.orgId, input.deletedAt)
			.run()
		total += result.meta.changes ?? 0
	}
	const teamMembers = await input.appDb
		.prepare(
			`UPDATE team_members
			 SET deleted_at = NULL
			 WHERE deleted_at = ?
			   AND team_id IN (SELECT id FROM teams WHERE org_id = ?)`,
		)
		.bind(input.deletedAt, input.orgId)
		.run()
	total += teamMembers.meta.changes ?? 0
	const listings = await input.appDb
		.prepare(
			`UPDATE community_listings
			 SET deleted_at = NULL, deleting_at = NULL
			 WHERE owner_user_id = ? AND deleted_at = ?`,
		)
		.bind(input.orgId, input.deletedAt)
		.run()
	total += listings.meta.changes ?? 0
	return total
}

export async function softDeleteOrg(input: {
	env: Env
	orgId: string
	actorUserId?: string | null
	actorUsername?: string | null
	now?: Date
}): Promise<SoftDeleteOrgResult> {
	const deletedAt = (input.now ?? new Date()).toISOString()
	const appDb = input.env.APP_DB
	const orgUpdate = await appDb
		.prepare(
			`UPDATE orgs
			 SET deleted_at = ?, updated_at = ?
			 WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(deletedAt, deletedAt, input.orgId)
		.run()
	if ((orgUpdate.meta.changes ?? 0) === 0) {
		throw new Error('org_not_found_or_already_deleted')
	}

	// Spec §10.1 / §10.3: revoke credentials bound to the org. Soft-delete also
	// tombstones api_tokens rows; restore never clears those tombstones.
	await appDb
		.prepare(
			`UPDATE api_tokens
			 SET revoked_at = ?, updated_at = ?
			 WHERE user_id = ?
			   AND revoked_at IS NULL
			   AND deleted_at IS NULL`,
		)
		.bind(deletedAt, deletedAt, input.orgId)
		.run()
	await appDb
		.prepare(`DELETE FROM cli_credential_bootstrap_codes WHERE user_id = ?`)
		.bind(input.orgId)
		.run()

	const resourceRowsSoftDeleted = await softDeleteOrgOwnedAppRows({
		appDb,
		orgId: input.orgId,
		deletedAt,
	})
	const jobsSoftDeleted = await jobsData(input.env).softDeleteJobsForUser({
		userId: input.orgId,
		deletedAt,
	})
	await syncJobManagerAlarm({ env: input.env, userId: input.orgId })

	await logOrgAuditEvent({
		env: input.env,
		orgId: input.orgId,
		action: 'org.deleted',
		result: 'success',
		actorUserId: input.actorUserId,
		actorUsername: input.actorUsername,
		detailsJson: JSON.stringify({
			deletedAt,
			resourceRowsSoftDeleted,
			jobsSoftDeleted,
		}),
		createdAt: deletedAt,
	})

	return {
		orgId: input.orgId,
		deletedAt,
		resourceRowsSoftDeleted,
		jobsSoftDeleted,
	}
}

export async function restoreOrg(input: {
	env: Env
	orgId: string
	actorUserId?: string | null
	actorUsername?: string | null
	now?: Date
}) {
	const now = input.now ?? new Date()
	const appDb = input.env.APP_DB
	const row = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind(input.orgId)
		.first<{ deleted_at: string | null }>()
	if (!row?.deleted_at) {
		throw new Error('org_not_deleted')
	}
	if (!isWithinSoftDeleteRestoreWindow(row.deleted_at, now)) {
		throw new OrgRestoreWindowExpiredError()
	}
	const deletedAt = row.deleted_at
	const restoredAt = now.toISOString()

	const orgUpdate = await appDb
		.prepare(
			`UPDATE orgs
			 SET deleted_at = NULL, deleting_at = NULL, updated_at = ?
			 WHERE id = ? AND deleted_at = ?`,
		)
		.bind(restoredAt, input.orgId, deletedAt)
		.run()
	if ((orgUpdate.meta.changes ?? 0) === 0) {
		throw new Error('org_restore_race')
	}

	const resourceRowsRestored = await restoreOrgOwnedAppRows({
		appDb,
		orgId: input.orgId,
		deletedAt,
	})
	const jobsRestored = await jobsData(input.env).restoreJobsForUser({
		userId: input.orgId,
		deletedAt,
		restoredAt,
	})
	await syncJobManagerAlarm({ env: input.env, userId: input.orgId })

	await logOrgAuditEvent({
		env: input.env,
		orgId: input.orgId,
		action: 'org.restored',
		result: 'success',
		actorUserId: input.actorUserId,
		actorUsername: input.actorUsername,
		detailsJson: JSON.stringify({
			restoredDeletedAt: deletedAt,
			resourceRowsRestored,
			jobsRestored,
		}),
		createdAt: restoredAt,
	})

	return {
		orgId: input.orgId,
		restoredAt,
		resourceRowsRestored,
		jobsRestored,
	}
}

export async function assertUserDeleteNotBlockedAsSoleOwner(input: {
	db: D1Database
	userId: string
}) {
	const memberships = await input.db
		.prepare(
			`SELECT m.org_id AS org_id, m.role AS role, o.slug AS slug
			 FROM org_memberships m
			 INNER JOIN orgs o ON o.id = m.org_id
			 WHERE m.user_id = ?
			   AND m.deleted_at IS NULL
			   AND o.deleted_at IS NULL`,
		)
		.bind(input.userId)
		.all<{ org_id: string; role: string; slug: string }>()

	const blockers: Array<{ orgId: string; orgSlug: string }> = []
	for (const membership of memberships.results ?? []) {
		if (membership.role !== 'owner') continue
		const others = await input.db
			.prepare(
				`SELECT COUNT(*) AS count FROM org_memberships
				 WHERE org_id = ? AND user_id != ?${andLiveDeletedAtSql()}`,
			)
			.bind(membership.org_id, input.userId)
			.first<{ count: number }>()
		const otherMemberCount = Number(others?.count ?? 0)
		if (otherMemberCount === 0) continue
		const otherOwners = await input.db
			.prepare(
				`SELECT COUNT(*) AS count FROM org_memberships
				 WHERE org_id = ? AND role = 'owner' AND user_id != ?${andLiveDeletedAtSql()}`,
			)
			.bind(membership.org_id, input.userId)
			.first<{ count: number }>()
		if (Number(otherOwners?.count ?? 0) === 0) {
			blockers.push({
				orgId: membership.org_id,
				orgSlug: membership.slug,
			})
		}
	}
	if (blockers.length > 0) {
		throw new UserDeleteBlockedSoleOwnerError(blockers)
	}
}

/**
 * Soft-delete a user and their sole-member orgs. Other-org memberships go
 * through {@link onMemberSoftRemoved}.
 */
export async function softDeleteUserAccount(input: {
	env: Env
	userId: string
	actorUserId?: string | null
	actorUsername?: string | null
	now?: Date
}) {
	await assertUserDeleteNotBlockedAsSoleOwner({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	const deletedAt = (input.now ?? new Date()).toISOString()
	const userUpdate = await input.env.APP_DB.prepare(
		`UPDATE users
		 SET deleted_at = ?, updated_at = ?
		 WHERE stable_user_id = ? AND deleted_at IS NULL`,
	)
		.bind(deletedAt, deletedAt, input.userId)
		.run()
	if ((userUpdate.meta.changes ?? 0) === 0) {
		throw new Error('user_not_found_or_already_deleted')
	}

	const soleMemberOrgs = await input.env.APP_DB.prepare(
		`SELECT m.org_id AS org_id
		 FROM org_memberships m
		 WHERE m.user_id = ?
		   AND m.deleted_at IS NULL
		   AND (
		     SELECT COUNT(*) FROM org_memberships o
		     WHERE o.org_id = m.org_id AND o.deleted_at IS NULL
		   ) = 1`,
	)
		.bind(input.userId)
		.all<{ org_id: string }>()

	const deletedOrgIds: Array<string> = []
	for (const row of soleMemberOrgs.results ?? []) {
		await softDeleteOrg({
			env: input.env,
			orgId: row.org_id,
			actorUserId: input.actorUserId ?? input.userId,
			actorUsername: input.actorUsername,
			now: new Date(deletedAt),
		})
		deletedOrgIds.push(row.org_id)
	}

	const otherMemberships = await input.env.APP_DB.prepare(
		`SELECT org_id FROM org_memberships
		 WHERE user_id = ? AND deleted_at IS NULL`,
	)
		.bind(input.userId)
		.all<{ org_id: string }>()
	for (const row of otherMemberships.results ?? []) {
		await onMemberSoftRemoved({
			env: input.env,
			orgId: row.org_id,
			userId: input.userId,
			deletedAt,
		})
	}

	await logOrgAuditEvent({
		env: input.env,
		orgId: input.userId,
		action: 'user.deleted',
		result: 'success',
		actorUserId: input.actorUserId ?? input.userId,
		actorUsername: input.actorUsername,
		targetUserId: input.userId,
		detailsJson: JSON.stringify({ deletedAt, deletedOrgIds }),
		createdAt: deletedAt,
	})

	return { userId: input.userId, deletedAt, deletedOrgIds }
}

/**
 * Restore a soft-deleted user and sole-member orgs tombstoned at the same
 * `deleted_at` within the restore window.
 */
export async function restoreUserAccount(input: {
	env: Env
	userId: string
	actorUserId?: string | null
	actorUsername?: string | null
	now?: Date
}) {
	const now = input.now ?? new Date()
	const restoredAt = now.toISOString()
	const userRow = await input.env.APP_DB.prepare(
		`SELECT deleted_at FROM users WHERE stable_user_id = ?`,
	)
		.bind(input.userId)
		.first<{ deleted_at: string | null }>()
	if (!userRow?.deleted_at) {
		throw new Error('user_not_deleted')
	}
	if (!isWithinSoftDeleteRestoreWindow(userRow.deleted_at, now)) {
		throw new OrgRestoreWindowExpiredError()
	}
	const deletedAt = userRow.deleted_at

	const userUpdate = await input.env.APP_DB.prepare(
		`UPDATE users
		 SET deleted_at = NULL, deleting_at = NULL, updated_at = ?
		 WHERE stable_user_id = ? AND deleted_at = ?`,
	)
		.bind(restoredAt, input.userId, deletedAt)
		.run()
	if ((userUpdate.meta.changes ?? 0) === 0) {
		throw new Error('user_restore_race')
	}

	const deletedOrgs = await input.env.APP_DB.prepare(
		`SELECT id FROM orgs WHERE deleted_at = ?`,
	)
		.bind(deletedAt)
		.all<{ id: string }>()
	const restoredOrgIds: Array<string> = []
	for (const row of deletedOrgs.results ?? []) {
		const membership = await input.env.APP_DB.prepare(
			`SELECT 1 AS ok FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at = ?`,
		)
			.bind(row.id, input.userId, deletedAt)
			.first<{ ok: number }>()
		if (!membership) continue
		await restoreOrg({
			env: input.env,
			orgId: row.id,
			actorUserId: input.actorUserId ?? input.userId,
			actorUsername: input.actorUsername,
			now,
		})
		restoredOrgIds.push(row.id)
	}

	await logOrgAuditEvent({
		env: input.env,
		orgId: input.userId,
		action: 'user.restored',
		result: 'success',
		actorUserId: input.actorUserId ?? input.userId,
		actorUsername: input.actorUsername,
		targetUserId: input.userId,
		detailsJson: JSON.stringify({
			restoredDeletedAt: deletedAt,
			restoredOrgIds,
		}),
		createdAt: restoredAt,
	})

	return { userId: input.userId, restoredAt, restoredOrgIds }
}

const resourceRestoreTableByType: Record<string, string> = {
	package: 'saved_packages',
	secret: 'secret_buckets',
	integration: 'user_integrations',
	memory: 'mcp_memories',
	email: 'email_inboxes',
}

/** Minimal P7 restore for one org-owned resource row (stub for MCP). */
export async function restoreResourceRow(input: {
	env: Env
	orgId: string
	resourceType: string
	resourceId: string
	now?: Date
}): Promise<{ restored: boolean }> {
	const table =
		resourceRestoreTableByType[input.resourceType.trim().toLowerCase()]
	if (!table) return { restored: false }
	const org = await input.env.APP_DB.prepare(
		`SELECT deleted_at FROM orgs WHERE id = ? AND deleted_at IS NOT NULL`,
	)
		.bind(input.orgId)
		.first<{ deleted_at: string }>()
	if (!org?.deleted_at) return { restored: false }
	if (!isWithinSoftDeleteRestoreWindow(org.deleted_at, input.now)) {
		throw new OrgRestoreWindowExpiredError()
	}
	const result = await input.env.APP_DB.prepare(
		`UPDATE ${table}
		 SET deleted_at = NULL
		 WHERE user_id = ? AND id = ? AND deleted_at = ?`,
	)
		.bind(input.orgId, input.resourceId, org.deleted_at)
		.run()
	return { restored: (result.meta.changes ?? 0) > 0 }
}
