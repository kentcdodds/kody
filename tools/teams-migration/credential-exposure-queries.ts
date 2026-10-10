/**
 * Read-only D1 counts for ambient credential-use blast radius after Teams.
 * Counts and ids only. Reuses assertReadOnlySql from production-queries.
 *
 * Report shape (sealed):
 * - orgs with more than one live member, or any outside grants
 * - secret / integration (MCP servers are integration resources) audit rows
 *   where the actor was not an org owner and not a granted subject for that
 *   resource (user grant or team grant membership)
 *
 * Saved packages' implicit self-authored access is intentionally left as-is;
 * the credentials redesign series removes it. The full `resolveCredential`
 * choke point is the first PR of that series (not a separate GitHub issue).
 *
 * Usage (same Cloudflare env as teams-production-queries):
 *   node tools/teams-migration/credential-exposure-queries.ts \
 *     --target production|kody-branch-* \
 *     --recipient-public-key <base64 SPKI> --out report.sealed.json
 */
import { writeFile } from 'node:fs/promises'
import { isExecutedDirectly } from '../node-runtime.ts'
import { fail } from '../ci/resource-utils.ts'
import {
	assertRehearsalWorkerName,
	type CloudflareClient,
} from '../preview-rehearsal/d1-rehearsal.ts'
import {
	importRecipientPublicKey,
	sealJson,
} from '../preview-rehearsal/seal.ts'
import {
	assertReadOnlySql,
	parseQueryTarget,
	readOnlyD1Query,
	resolveD1Uuid,
	targetResourceNames,
	type QueryTarget,
} from './production-queries.ts'
import { buildPreviewResourceNames } from '../ci/preview-resources.ts'

/** Orgs with more than one live member (personal org alone is always 1). */
export const multiMemberOrgsSql = `SELECT o.id AS org_id, o.slug AS slug,
	(SELECT COUNT(*) FROM org_memberships m
	 WHERE m.org_id = o.id AND m.deleted_at IS NULL) AS member_count
FROM orgs o
WHERE o.deleted_at IS NULL
	AND (SELECT COUNT(*) FROM org_memberships m
	     WHERE m.org_id = o.id AND m.deleted_at IS NULL) > 1
ORDER BY member_count DESC, o.slug`

/** Live grants whose subject is not a live member of that org (outside collab). */
export const outsideGrantsSql = `SELECT g.org_id AS org_id, g.id AS grant_id,
	g.resource_type AS resource_type, g.resource_id AS resource_id,
	g.subject_type AS subject_type, g.subject_id AS subject_id, g.preset AS preset
FROM grants g
WHERE g.deleted_at IS NULL
	AND g.subject_type = 'user'
	AND NOT EXISTS (
		SELECT 1 FROM org_memberships m
		WHERE m.org_id = g.org_id
			AND m.user_id = g.subject_id
			AND m.deleted_at IS NULL
	)
ORDER BY g.org_id, g.resource_type, g.resource_id`

/** Orgs that have any outside grant (distinct). */
export const orgsWithOutsideGrantsSql = `SELECT DISTINCT g.org_id AS org_id
FROM grants g
WHERE g.deleted_at IS NULL
	AND g.subject_type = 'user'
	AND NOT EXISTS (
		SELECT 1 FROM org_memberships m
		WHERE m.org_id = g.org_id
			AND m.user_id = g.subject_id
			AND m.deleted_at IS NULL
	)`

/**
 * Org audit rows for secret/integration resources where the actor is not the
 * org id. MCP servers authorize as integration resources. AUDIT_DB has no
 * org_memberships / grants (APP_DB only), so owner and grant filtering happens
 * in JS after APP_DB membership and grant queries.
 */
/** Cap on AUDIT_DB candidates before APP_DB owner/grant filtering. */
export const credentialAuditCandidateLimit = 500

export const credentialAuditCandidateSql = `SELECT e.org_id AS org_id,
	e.action AS action, e.resource_type AS resource_type,
	e.resource_id AS resource_id, e.actor_user_id AS actor_user_id,
	e.result AS result, e.created_at AS created_at
FROM org_audit_events e
WHERE e.resource_type IN ('secret', 'integration')
	AND e.actor_user_id IS NOT NULL
	AND e.actor_user_id != e.org_id
ORDER BY e.created_at DESC
LIMIT ${credentialAuditCandidateLimit}`

/** Live owner memberships used to filter audit candidates in-process. */
export const liveOwnerMembershipsSql = `SELECT org_id, user_id
FROM org_memberships
WHERE role = 'owner' AND deleted_at IS NULL`

/**
 * Live secret/integration grants (user or team subjects). MCP servers use the
 * integration resource type.
 */
export const liveCredentialGrantsSql = `SELECT g.org_id AS org_id,
	g.resource_type AS resource_type, g.resource_id AS resource_id,
	g.subject_type AS subject_type, g.subject_id AS subject_id
FROM grants g
WHERE g.deleted_at IS NULL
	AND g.resource_type IN ('secret', 'integration')`

/** Live team memberships for resolving team-subject grants to users. */
export const liveTeamMembersSql = `SELECT team_id, user_id
FROM team_members
WHERE deleted_at IS NULL`

export type CredentialExposureReport = {
	version: 2
	target: string
	ranAt: string
	/**
	 * Orgs where ambient credential use by a non-owner was possible before the
	 * per-resource Use fix: more than one live member, or any outside grant.
	 */
	orgsWithExposureSurface: { count: number; orgIds: Array<string> }
	multiMemberOrgs: { count: number; rows: Array<Record<string, unknown>> }
	outsideGrants: { count: number; rows: Array<Record<string, unknown>> }
	orgsWithOutsideGrants: { count: number }
	/**
	 * Capability / audit-surface events for secret or integration (incl. MCP)
	 * where the actor was not an org owner and not a granted subject. Ambient
	 * placeholder expansion did not write org_audit_events historically.
	 */
	nonOwnerOrGrantedCredentialAudit: {
		status: 'ok' | 'unavailable'
		count: number
		rows: Array<Record<string, unknown>>
		candidatesFetched: number
		candidatesTruncated: boolean
		error: string | null
		note: string
	}
	notes: Array<string>
}

async function resolveAuditD1Uuid(
	client: CloudflareClient,
	target: QueryTarget,
) {
	const name =
		target.kind === 'production'
			? 'kody-audit'
			: buildPreviewResourceNames(target.workerName).auditD1DatabaseName
	try {
		return await resolveD1Uuid(client, name)
	} catch {
		return null
	}
}

export function filterNonOwnerOrGrantedCredentialAudit(input: {
	candidates: Array<Record<string, unknown>>
	ownerKeys: Set<string>
	userGrantKeys: Set<string>
	teamGrantByResource: Map<string, Array<string>>
	teamMemberKeys: Set<string>
}) {
	return input.candidates.filter((row) => {
		const orgId = String(row['org_id'] ?? '')
		const actorId = String(row['actor_user_id'] ?? '')
		const resourceType = String(row['resource_type'] ?? '')
		const resourceId = String(row['resource_id'] ?? '')
		if (input.ownerKeys.has(`${orgId}:${actorId}`)) return false
		const resourceKey = `${orgId}:${resourceType}:${resourceId}`
		if (input.userGrantKeys.has(`${resourceKey}:user:${actorId}`)) {
			return false
		}
		const teamIds = input.teamGrantByResource.get(resourceKey) ?? []
		for (const teamId of teamIds) {
			if (input.teamMemberKeys.has(`${teamId}:${actorId}`)) return false
		}
		return true
	})
}

export async function runCredentialExposureQueries(input: {
	client: CloudflareClient
	target: QueryTarget
	now?: () => Date
}): Promise<CredentialExposureReport> {
	const names = await targetResourceNames(input.target)
	const appUuid = await resolveD1Uuid(input.client, names.appD1Name)
	assertReadOnlySql(multiMemberOrgsSql)
	assertReadOnlySql(outsideGrantsSql)
	assertReadOnlySql(orgsWithOutsideGrantsSql)
	assertReadOnlySql(credentialAuditCandidateSql)
	assertReadOnlySql(liveOwnerMembershipsSql)
	assertReadOnlySql(liveCredentialGrantsSql)
	assertReadOnlySql(liveTeamMembersSql)

	const multiMemberRows = await readOnlyD1Query<Record<string, unknown>>(
		input.client,
		appUuid,
		multiMemberOrgsSql,
	)
	const outsideGrantRows = await readOnlyD1Query<Record<string, unknown>>(
		input.client,
		appUuid,
		outsideGrantsSql,
	)
	const orgsWithOutside = await readOnlyD1Query<Record<string, unknown>>(
		input.client,
		appUuid,
		orgsWithOutsideGrantsSql,
	)
	const ownerMemberships = await readOnlyD1Query<{
		org_id: string
		user_id: string
	}>(input.client, appUuid, liveOwnerMembershipsSql)
	const ownerKeys = new Set(
		ownerMemberships.map((row) => `${row.org_id}:${row.user_id}`),
	)

	const credentialGrants = await readOnlyD1Query<{
		org_id: string
		resource_type: string
		resource_id: string
		subject_type: string
		subject_id: string
	}>(input.client, appUuid, liveCredentialGrantsSql)
	const userGrantKeys = new Set<string>()
	const teamGrantByResource = new Map<string, Array<string>>()
	for (const grant of credentialGrants) {
		const resourceKey = `${grant.org_id}:${grant.resource_type}:${grant.resource_id}`
		if (grant.subject_type === 'user') {
			userGrantKeys.add(`${resourceKey}:user:${grant.subject_id}`)
			continue
		}
		if (grant.subject_type === 'team') {
			const list = teamGrantByResource.get(resourceKey) ?? []
			list.push(grant.subject_id)
			teamGrantByResource.set(resourceKey, list)
		}
	}

	const teamMembers = await readOnlyD1Query<{
		team_id: string
		user_id: string
	}>(input.client, appUuid, liveTeamMembersSql)
	const teamMemberKeys = new Set(
		teamMembers.map((row) => `${row.team_id}:${row.user_id}`),
	)

	const exposureOrgIds = new Set<string>()
	for (const row of multiMemberRows) {
		exposureOrgIds.add(String(row['org_id'] ?? ''))
	}
	for (const row of orgsWithOutside) {
		exposureOrgIds.add(String(row['org_id'] ?? ''))
	}
	exposureOrgIds.delete('')

	const auditNote =
		'Ambient placeholder expansion did not write org_audit_events historically; rows here are capability-surface events only when present. MCP servers authorize as integration resources.'
	const auditUuid = await resolveAuditD1Uuid(input.client, input.target)
	let auditStatus: 'ok' | 'unavailable' = 'unavailable'
	let auditError: string | null = auditUuid
		? null
		: 'AUDIT_DB uuid could not be resolved (missing database or list error).'
	let candidatesFetched = 0
	let candidatesTruncated = false
	let auditRows: Array<Record<string, unknown>> = []
	if (auditUuid) {
		try {
			const candidates = await readOnlyD1Query<Record<string, unknown>>(
				input.client,
				auditUuid,
				credentialAuditCandidateSql,
			)
			candidatesFetched = candidates.length
			candidatesTruncated = candidates.length >= credentialAuditCandidateLimit
			auditRows = filterNonOwnerOrGrantedCredentialAudit({
				candidates,
				ownerKeys,
				userGrantKeys,
				teamGrantByResource,
				teamMemberKeys,
			})
			auditStatus = 'ok'
			auditError = null
		} catch (error) {
			auditStatus = 'unavailable'
			auditError = error instanceof Error ? error.message : String(error)
			auditRows = []
		}
	}

	return {
		version: 2,
		target:
			input.target.kind === 'production'
				? 'production'
				: input.target.workerName,
		ranAt: (input.now ?? (() => new Date()))().toISOString(),
		orgsWithExposureSurface: {
			count: exposureOrgIds.size,
			orgIds: [...exposureOrgIds].sort(),
		},
		multiMemberOrgs: {
			count: multiMemberRows.length,
			rows: multiMemberRows,
		},
		outsideGrants: {
			count: outsideGrantRows.length,
			rows: outsideGrantRows,
		},
		orgsWithOutsideGrants: { count: orgsWithOutside.length },
		nonOwnerOrGrantedCredentialAudit: {
			status: auditStatus,
			count: auditRows.length,
			rows: auditRows,
			candidatesFetched,
			candidatesTruncated,
			error: auditError,
			note: auditNote,
		},
		notes: [
			'Saved packages keep implicit self-authored credential access; the credentials redesign series removes it.',
			'The full resolveCredential(orgId, actor, packageStamp?) choke point is the first PR of the credentials redesign series, not a separate GitHub issue.',
			'CLI execute --local client package stamps are not credential authority (must hold secret:use / integration:use). Multi-member orgs are the practical blast radius for that former gap; no durable audit of local stamps exists.',
		],
	}
}

const usage = [
	'Usage: node tools/teams-migration/credential-exposure-queries.ts --target <production|kody-branch-*> --recipient-public-key <base64 SPKI> --out <report.sealed.json>',
	'',
	'Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.',
].join('\n')

function readFlag(argv: ReadonlyArray<string>, flag: string) {
	const index = argv.indexOf(flag)
	const value = index === -1 ? undefined : argv[index + 1]
	if (!value || value.startsWith('--'))
		fail(`Missing ${flag} <value>.\n${usage}`)
	return value
}

function requireEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) fail(`${name} is required.\n${usage}`)
	return value
}

if (isExecutedDirectly(import.meta.url)) {
	const argv = process.argv.slice(2)
	const target = parseQueryTarget(readFlag(argv, '--target'))
	if (target.kind === 'preview') {
		assertRehearsalWorkerName(target.workerName)
	}
	const publicKey = await importRecipientPublicKey(
		readFlag(argv, '--recipient-public-key'),
	)
	const outPath = readFlag(argv, '--out')
	const client: CloudflareClient = {
		accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: requireEnv('CLOUDFLARE_API_TOKEN'),
	}
	const report = await runCredentialExposureQueries({ client, target })
	await writeFile(
		outPath,
		`${JSON.stringify(await sealJson(report, publicKey), null, 2)}\n`,
	)
	console.log(
		`Wrote the sealed report to ${outPath}. Open it with node tools/preview-rehearsal/seal.ts open.`,
	)
}
