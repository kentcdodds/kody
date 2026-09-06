/**
 * Write-once activation timestamps on `users` for the post-auth factory funnel.
 * Prefer these first-seen columns over reconstructing from usage/MCP warehouses.
 * Never throws: activation metering must not break MCP, execute, or package paths.
 */

import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'

function nowIso(at?: string) {
	return at ?? new Date().toISOString()
}

/**
 * Stamp first successful MCP/agent connection and optional client name.
 * Also refreshes last_active_at when the calendar day advances.
 */
export async function stampFirstMcpConnected(
	db: D1Database,
	input: {
		stableUserId: string
		clientName?: string | null
		at?: string
	},
): Promise<void> {
	try {
		const at = nowIso(input.at)
		const clientName =
			typeof input.clientName === 'string' && input.clientName.trim()
				? input.clientName.trim().slice(0, 200)
				: null
		await db
			.prepare(
				`UPDATE users
				SET first_mcp_connected_at = COALESCE(first_mcp_connected_at, ?1),
					mcp_client_name = CASE
						WHEN mcp_client_name IS NULL AND ?2 IS NOT NULL THEN ?2
						ELSE mcp_client_name
					END,
					last_active_at = CASE
						WHEN last_active_at IS NULL THEN ?1
						WHEN date(last_active_at) < date(?1) THEN ?1
						ELSE last_active_at
					END,
					updated_at = CASE
						WHEN first_mcp_connected_at IS NULL
							OR (mcp_client_name IS NULL AND ?2 IS NOT NULL)
							OR last_active_at IS NULL
							OR date(last_active_at) < date(?1)
						THEN ?3
						ELSE updated_at
					END
				WHERE stable_user_id = ?4
					AND (
						first_mcp_connected_at IS NULL
						OR (mcp_client_name IS NULL AND ?2 IS NOT NULL)
						OR last_active_at IS NULL
						OR date(last_active_at) < date(?1)
					)`,
			)
			.bind(at, clientName, utcSqliteTimestamp(), input.stableUserId)
			.run()
	} catch (error) {
		console.debug('activation-stamp-mcp-failed', error)
	}
}

export async function userHasFirstExecute(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	try {
		const row = await db
			.prepare(
				`SELECT first_execute_at
				 FROM users
				 WHERE stable_user_id = ?
				 LIMIT 1`,
			)
			.bind(userId)
			.first<{ first_execute_at: string | null }>()
		return Boolean(row?.first_execute_at)
	} catch {
		return false
	}
}

export async function userHasFirstSearch(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	try {
		const row = await db
			.prepare(
				`SELECT first_search_at
				 FROM users
				 WHERE stable_user_id = ?
				 LIMIT 1`,
			)
			.bind(userId)
			.first<{ first_search_at: string | null }>()
		return Boolean(row?.first_search_at)
	} catch {
		return false
	}
}

export async function stampFirstExecute(
	db: D1Database,
	input: { stableUserId: string; at?: string },
): Promise<void> {
	try {
		const at = nowIso(input.at)
		await db
			.prepare(
				`UPDATE users
				SET first_execute_at = COALESCE(first_execute_at, ?1),
					last_active_at = CASE
						WHEN last_active_at IS NULL THEN ?1
						WHEN date(last_active_at) < date(?1) THEN ?1
						ELSE last_active_at
					END,
					updated_at = CASE
						WHEN first_execute_at IS NULL
							OR last_active_at IS NULL
							OR date(last_active_at) < date(?1)
						THEN ?2
						ELSE updated_at
					END
				WHERE stable_user_id = ?3
					AND (
						first_execute_at IS NULL
						OR last_active_at IS NULL
						OR date(last_active_at) < date(?1)
					)`,
			)
			.bind(at, utcSqliteTimestamp(), input.stableUserId)
			.run()
	} catch (error) {
		console.debug('activation-stamp-execute-failed', error)
	}
}

export async function stampFirstSearch(
	db: D1Database,
	input: { stableUserId: string; at?: string },
): Promise<void> {
	try {
		const at = nowIso(input.at)
		await db
			.prepare(
				`UPDATE users
				SET first_search_at = COALESCE(first_search_at, ?1),
					last_active_at = CASE
						WHEN last_active_at IS NULL THEN ?1
						WHEN date(last_active_at) < date(?1) THEN ?1
						ELSE last_active_at
					END,
					updated_at = CASE
						WHEN first_search_at IS NULL
							OR last_active_at IS NULL
							OR date(last_active_at) < date(?1)
						THEN ?2
						ELSE updated_at
					END
				WHERE stable_user_id = ?3
					AND (
						first_search_at IS NULL
						OR last_active_at IS NULL
						OR date(last_active_at) < date(?1)
					)`,
			)
			.bind(at, utcSqliteTimestamp(), input.stableUserId)
			.run()
	} catch (error) {
		console.debug('activation-stamp-search-failed', error)
	}
}

export async function stampFirstSavedPackage(
	db: D1Database,
	input: { stableUserId: string; at?: string },
): Promise<void> {
	try {
		const at = nowIso(input.at)
		await db
			.prepare(
				`UPDATE users
				SET first_saved_package_at = COALESCE(first_saved_package_at, ?1),
					last_active_at = CASE
						WHEN last_active_at IS NULL THEN ?1
						WHEN date(last_active_at) < date(?1) THEN ?1
						ELSE last_active_at
					END,
					updated_at = CASE
						WHEN first_saved_package_at IS NULL
							OR last_active_at IS NULL
							OR date(last_active_at) < date(?1)
						THEN ?2
						ELSE updated_at
					END
				WHERE stable_user_id = ?3
					AND (
						first_saved_package_at IS NULL
						OR last_active_at IS NULL
						OR date(last_active_at) < date(?1)
					)`,
			)
			.bind(at, utcSqliteTimestamp(), input.stableUserId)
			.run()
	} catch (error) {
		console.debug('activation-stamp-saved-package-failed', error)
	}
}

/** Refresh last_active_at on login (and similar return signals). */
export async function touchLastActiveAt(
	db: D1Database,
	input: { stableUserId: string; at?: string },
): Promise<void> {
	try {
		const at = nowIso(input.at)
		await db
			.prepare(
				`UPDATE users
				SET last_active_at = ?1,
					updated_at = ?2
				WHERE stable_user_id = ?3
					AND (last_active_at IS NULL OR date(last_active_at) < date(?1))`,
			)
			.bind(at, utcSqliteTimestamp(), input.stableUserId)
			.run()
	} catch (error) {
		console.debug('activation-touch-last-active-failed', error)
	}
}
