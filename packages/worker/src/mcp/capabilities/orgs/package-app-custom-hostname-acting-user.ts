import { McpCallerError } from '#mcp/caller-error.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * Resolve the acting person's numeric `users.id` for feature-flag audience
 * evaluation. Custom-hostname management is person-gated
 * (`experiments_opt_in`), so agent-only callers are refused.
 */
export async function resolvePackageAppCustomHostnameActingUserId(input: {
	db: D1Database
	stableUserId: string | null | undefined
}): Promise<number> {
	const stable = input.stableUserId?.trim()
	if (!stable) {
		throw new McpCallerError(
			'Custom hostnames must be managed by a person with org:write.',
		)
	}
	const row = await input.db
		.prepare(
			`SELECT id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(stable)
		.first<{ id: number }>()
	if (!row) {
		throw new McpCallerError(
			'Custom hostnames must be managed by a person with org:write.',
		)
	}
	return row.id
}
