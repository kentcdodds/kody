/**
 * Repair / re-apply the P4 API token scope rewrite using the TypeScript map.
 *
 * Production and `wrangler d1 migrations apply` use the SQL in
 * `0090-teams-credential-org-binding.sql` (temp expand table + json_each).
 * This companion is for local D1 repair when a row was inserted with legacy
 * scopes after apply, or when checking that SQL and TS stay aligned.
 *
 *   import { rewriteStoredApiTokenScopes } from './rewrite-api-token-scopes.ts'
 *   await rewriteStoredApiTokenScopes(env.APP_DB)
 */
import { rewriteLegacyApiTokenScopes } from '#worker/api-tokens/legacy-scope-rewrite.ts'

const scopedCredentialTables = [
	'api_tokens',
	'cli_credential_bootstrap_codes',
] as const

export type RewriteStoredApiTokenScopesResult = {
	table: (typeof scopedCredentialTables)[number]
	updated: number
}

export async function rewriteStoredApiTokenScopes(
	db: D1Database,
): Promise<Array<RewriteStoredApiTokenScopesResult>> {
	const results: Array<RewriteStoredApiTokenScopesResult> = []
	for (const table of scopedCredentialTables) {
		const rows = await db
			.prepare(`SELECT id, scopes_json FROM ${table}`)
			.all<{ id: string; scopes_json: string }>()
		let updated = 0
		for (const row of rows.results ?? []) {
			let parsed: unknown
			try {
				parsed = JSON.parse(row.scopes_json)
			} catch {
				throw new Error(`${table} ${row.id}: scopes_json is not valid JSON.`)
			}
			if (
				!Array.isArray(parsed) ||
				!parsed.every((value): value is string => typeof value === 'string')
			) {
				throw new Error(
					`${table} ${row.id}: scopes_json must be a string array.`,
				)
			}
			const rewritten = rewriteLegacyApiTokenScopes(parsed)
			const next = JSON.stringify(rewritten)
			if (next === JSON.stringify([...parsed].sort())) continue
			await db
				.prepare(`UPDATE ${table} SET scopes_json = ? WHERE id = ?`)
				.bind(next, row.id)
				.run()
			updated += 1
		}
		results.push({ table, updated })
	}
	return results
}
