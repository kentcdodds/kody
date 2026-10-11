/**
 * Read-only counts for moving credential grants from names to stable
 * credential ids (credentials plan v4, PR 2). Before the migration it dry-runs
 * the mapping: every live or deleted `secret` / `integration` grant (and grant
 * invite) must resolve to exactly one credential row in its org. After the
 * migration it checks that every `credential` grant resolves to exactly one
 * row by id. Counts and ids only; credential names never leave D1.
 */
import { assertReadOnlySql } from './production-queries.ts'

/** Grants and their permission rows per resource type and live/deleted state. */
export const grantTotalsSql = `SELECT g.resource_type AS resource_type,
	CASE WHEN g.deleted_at IS NULL THEN 'live' ELSE 'deleted' END AS grant_state,
	COUNT(*) AS grants,
	COALESCE(SUM((SELECT COUNT(*) FROM grant_permissions gp WHERE gp.grant_id = g.id)), 0) AS permissions
FROM grants g
GROUP BY g.resource_type, grant_state
ORDER BY g.resource_type, grant_state`

/** Grant invites per resource type and status. */
export const grantInviteTotalsSql = `SELECT i.resource_type AS resource_type,
	i.status AS status,
	COUNT(*) AS invites
FROM invites i
WHERE i.kind = 'grant'
GROUP BY i.resource_type, i.status
ORDER BY i.resource_type, i.status`

/**
 * Candidate credential rows for a name in an org. Soft-deleted rows count:
 * they keep their id and come back on restore. Each table allows at most one
 * row per (org, name), so every count is 0 or 1.
 */
function nameCandidateColumns(orgColumn: string, nameColumn: string) {
	return `(SELECT COUNT(*) FROM secret_entries e
		JOIN secret_buckets b ON b.id = e.bucket_id
		WHERE b.user_id = ${orgColumn} AND b.scope = 'user' AND b.binding_key = ''
			AND e.name = ${nameColumn}) AS org_secret_matches,
	(SELECT COUNT(*) FROM secret_entries e
		JOIN secret_buckets b ON b.id = e.bucket_id
		WHERE b.user_id = ${orgColumn} AND NOT (b.scope = 'user' AND b.binding_key = '')
			AND e.name = ${nameColumn}) AS scoped_secret_matches,
	(SELECT COUNT(*) FROM secret_provider_bindings p
		WHERE p.user_id = ${orgColumn} AND p.door_secret_name = ${nameColumn}) AS vault_door_matches,
	(SELECT COUNT(*) FROM user_integrations ui
		WHERE ui.user_id = ${orgColumn} AND ui.name = ${nameColumn}) AS integration_matches,
	(SELECT COUNT(*) FROM mcp_server_settings s
		WHERE s.user_id = ${orgColumn} AND s.name = ${nameColumn}) AS mcp_server_matches`
}

/** Every name-keyed credential grant with its candidate rows. */
export const nameKeyedCredentialGrantsSql = `SELECT g.id AS grant_id,
	g.org_id AS org_id,
	g.resource_type AS resource_type,
	CASE WHEN g.deleted_at IS NULL THEN 'live' ELSE 'deleted' END AS grant_state,
	CASE WHEN o.id IS NULL THEN 'missing'
		WHEN o.deleted_at IS NULL THEN 'live' ELSE 'deleted' END AS org_state,
	(SELECT COUNT(*) FROM grant_permissions gp WHERE gp.grant_id = g.id) AS permissions,
	${nameCandidateColumns('g.org_id', 'g.resource_id')}
FROM grants g
LEFT JOIN orgs o ON o.id = g.org_id
WHERE g.resource_type IN ('secret', 'integration')
ORDER BY g.org_id, g.id`

/** Every name-keyed credential grant invite with its candidate rows. */
export const nameKeyedCredentialInvitesSql = `SELECT i.id AS invite_id,
	i.org_id AS org_id,
	i.resource_type AS resource_type,
	i.status AS status,
	${nameCandidateColumns('i.org_id', 'i.resource_id')}
FROM invites i
WHERE i.kind = 'grant' AND i.resource_type IN ('secret', 'integration')
ORDER BY i.org_id, i.id`

/**
 * Every id-keyed credential grant with the rows its id matches in its org.
 * Fails with "no such column" before the migration adds the id columns.
 */
export const credentialGrantsByIdSql = `SELECT g.id AS grant_id,
	g.org_id AS org_id,
	CASE WHEN g.deleted_at IS NULL THEN 'live' ELSE 'deleted' END AS grant_state,
	(SELECT COUNT(*) FROM grant_permissions gp WHERE gp.grant_id = g.id) AS permissions,
	(SELECT COUNT(*) FROM secret_entries e
		JOIN secret_buckets b ON b.id = e.bucket_id
		WHERE b.user_id = g.org_id AND e.id = g.resource_id) AS secret_matches,
	(SELECT COUNT(*) FROM secret_provider_bindings p
		WHERE p.user_id = g.org_id AND p.id = g.resource_id) AS vault_matches,
	(SELECT COUNT(*) FROM user_integrations ui
		WHERE ui.user_id = g.org_id AND ui.id = g.resource_id) AS integration_matches,
	(SELECT COUNT(*) FROM mcp_server_settings s
		WHERE s.user_id = g.org_id AND s.id = g.resource_id) AS mcp_server_matches
FROM grants g
WHERE g.resource_type = 'credential'
ORDER BY g.org_id, g.id`

export const credentialGrantIdSql = [
	grantTotalsSql,
	grantInviteTotalsSql,
	nameKeyedCredentialGrantsSql,
	nameKeyedCredentialInvitesSql,
	credentialGrantsByIdSql,
] as const

for (const sql of credentialGrantIdSql) assertReadOnlySql(sql)

type CandidateCounts = {
	org_secret_matches: number
	scoped_secret_matches: number
	vault_door_matches: number
	integration_matches: number
	mcp_server_matches: number
}

/**
 * - `mapped`: exactly one credential row carries the name.
 * - `orphan`: no row carries it (fails the migration).
 * - `ambiguous`: more than one row carries it (fails the migration).
 * - `shared-with-vault`: the secret is also a vault door key, so the old
 *   name grant covered vault use too (fails the migration: one grant cannot
 *   become two ids without changing who can use what).
 * - `also-scoped`: a package or session secret in the org shares the name,
 *   and resolution prefers it in that storage context, so the old name grant
 *   covered it too (fails the migration for the same reason).
 */
export type NameKeyedOutcome =
	| 'mapped'
	| 'orphan'
	| 'ambiguous'
	| 'shared-with-vault'
	| 'also-scoped'

export function classifyNameKeyedCredential(
	resourceType: string,
	counts: CandidateCounts,
): NameKeyedOutcome {
	switch (resourceType) {
		case 'secret': {
			const matches = Number(counts.org_secret_matches)
			if (matches === 0) return 'orphan'
			if (matches > 1) return 'ambiguous'
			if (Number(counts.vault_door_matches) > 0) return 'shared-with-vault'
			if (Number(counts.scoped_secret_matches) > 0) return 'also-scoped'
			return 'mapped'
		}
		case 'integration': {
			const matches =
				Number(counts.integration_matches) + Number(counts.mcp_server_matches)
			if (matches === 0) return 'orphan'
			if (matches > 1) return 'ambiguous'
			return 'mapped'
		}
		default:
			throw new Error(
				`Unexpected name-keyed credential resource type ${resourceType}.`,
			)
	}
}

type CredentialMatchCounts = {
	secret_matches: number
	vault_matches: number
	integration_matches: number
	mcp_server_matches: number
}

/** `resolved` when the id matches exactly one credential row in its org. */
export function classifyCredentialGrant(counts: CredentialMatchCounts) {
	const matches =
		Number(counts.secret_matches) +
		Number(counts.vault_matches) +
		Number(counts.integration_matches) +
		Number(counts.mcp_server_matches)
	if (matches === 1) return 'resolved' as const
	return matches === 0 ? ('orphan' as const) : ('ambiguous' as const)
}

export function countBy<T>(
	rows: ReadonlyArray<T>,
	key: (row: T) => string,
): Record<string, number> {
	const counts: Record<string, number> = {}
	for (const row of rows) {
		const value = key(row)
		counts[value] = (counts[value] ?? 0) + 1
	}
	return counts
}
