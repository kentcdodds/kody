/**
 * Read-only counts for credential grants keyed by stable credential id
 * (credentials plan v4, PR 2). Grant and invite totals per resource type, and
 * a check that every `credential` grant resolves to exactly one credential row
 * in its org. Counts and ids only; credential names never leave D1.
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
 * Every credential grant with the rows its id matches in its org. Soft-deleted
 * credential rows count: they keep their id and come back on restore.
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

const credentialGrantIdSql = [
	grantTotalsSql,
	grantInviteTotalsSql,
	credentialGrantsByIdSql,
] as const

for (const sql of credentialGrantIdSql) assertReadOnlySql(sql)

type CredentialMatchCounts = {
	secret_matches: number
	vault_matches: number
	integration_matches: number
	mcp_server_matches: number
}

/**
 * `resolved` when the id matches exactly one credential row in its org.
 * `orphan` is expected only for a grant whose credential was deleted later.
 */
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
