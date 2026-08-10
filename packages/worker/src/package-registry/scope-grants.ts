import { normalizeStableUserId, resolveUserStableId } from '#worker/user-id.ts'

/**
 * Package scope grants: explicit rows that let a person account act inside a
 * platform account's package scope (for example `@kody/*`).
 *
 * Grants are only representable on platform accounts (`users.account_type =
 * 'platform'`). Person accounts can never be the target of a grant, so
 * "act as another user" is structurally unrepresentable — enforced in
 * `insertPackageScopeGrant` and re-checked at resolution time in
 * `package-owner.ts`.
 *
 * All user id columns hold stable MCP user ids (`users.stable_user_id`),
 * matching the other ownership tables and the account deletion/export
 * machinery.
 */

export type PackageScopeGrantRow = {
	scope_owner_user_id: string
	grantee_user_id: string
	created_by_user_id: string
	created_at: string
	scope_username: string
	grantee_username: string
}

export type PlatformAccountRow = {
	id: number
	username: string
	email: string
	stableUserId: string
}

/**
 * Usernames of every platform account. Platform scopes resolve live in
 * `kody:@scope/...` imports for all callers, so cross-scope policy checks
 * treat them as always-valid references.
 */
export async function listPlatformAccountUsernames(
	db: D1Database,
): Promise<Array<string>> {
	const result = await db
		.prepare(
			`SELECT username FROM users WHERE account_type = 'platform' ORDER BY username ASC`,
		)
		.all<{ username: string }>()
	return (result.results ?? []).map((row) => row.username)
}

export async function getPlatformAccountByUsername(
	db: D1Database,
	username: string,
): Promise<PlatformAccountRow | null> {
	const row = await db
		.prepare(
			`SELECT id, username, email, account_type, stable_user_id
			FROM users
			WHERE username = ?
			LIMIT 1`,
		)
		.bind(username)
		.first<{
			id: number
			username: string
			email: string
			account_type: string
			stable_user_id: string
		}>()
	if (!row || row.account_type !== 'platform') return null
	return {
		id: row.id,
		username: row.username,
		email: row.email,
		stableUserId: resolveUserStableId(row),
	}
}

async function isPlatformAccountStableUserId(
	db: D1Database,
	stableUserId: string,
) {
	const trimmed = normalizeStableUserId(stableUserId)
	if (!trimmed) return false
	const row = await db
		.prepare(`SELECT account_type FROM users WHERE stable_user_id = ?`)
		.bind(trimmed)
		.first<{ account_type: string }>()
	return row?.account_type === 'platform'
}

export async function hasPackageScopeGrant(
	db: D1Database,
	input: {
		scopeOwnerUserId: string
		granteeUserId: string
	},
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS granted FROM package_scope_grants
			WHERE scope_owner_user_id = ? AND grantee_user_id = ?
			LIMIT 1`,
		)
		.bind(input.scopeOwnerUserId, input.granteeUserId)
		.first<{ granted: number }>()
	return Boolean(row)
}

export async function insertPackageScopeGrant(
	db: D1Database,
	input: {
		scopeOwnerUserId: string
		granteeUserId: string
		createdByUserId: string
	},
): Promise<{ created: boolean }> {
	if (!(await isPlatformAccountStableUserId(db, input.scopeOwnerUserId))) {
		throw new Error(
			'Package scope grants can only be created on platform accounts.',
		)
	}
	const result = await db
		.prepare(
			`INSERT INTO package_scope_grants
			(scope_owner_user_id, grantee_user_id, created_by_user_id)
			VALUES (?, ?, ?)
			ON CONFLICT(scope_owner_user_id, grantee_user_id) DO NOTHING`,
		)
		.bind(input.scopeOwnerUserId, input.granteeUserId, input.createdByUserId)
		.run()
	return { created: (result.meta.changes ?? 0) > 0 }
}

export async function deletePackageScopeGrant(
	db: D1Database,
	input: {
		scopeOwnerUserId: string
		granteeUserId: string
	},
): Promise<{ deleted: boolean }> {
	const result = await db
		.prepare(
			`DELETE FROM package_scope_grants
			WHERE scope_owner_user_id = ? AND grantee_user_id = ?`,
		)
		.bind(input.scopeOwnerUserId, input.granteeUserId)
		.run()
	return { deleted: (result.meta.changes ?? 0) > 0 }
}

export async function listPackageScopeGrants(
	db: D1Database,
	input: {
		scopeOwnerUserId?: string
	} = {},
): Promise<Array<PackageScopeGrantRow>> {
	const where =
		input.scopeOwnerUserId === undefined
			? ''
			: 'WHERE grants.scope_owner_user_id = ?'
	const statement = db.prepare(
		`SELECT
			grants.scope_owner_user_id,
			grants.grantee_user_id,
			grants.created_by_user_id,
			grants.created_at,
			scope_users.username AS scope_username,
			grantee_users.username AS grantee_username
		FROM package_scope_grants AS grants
		INNER JOIN users AS scope_users
			ON scope_users.stable_user_id = grants.scope_owner_user_id
		INNER JOIN users AS grantee_users
			ON grantee_users.stable_user_id = grants.grantee_user_id
		${where}
		ORDER BY grants.created_at ASC`,
	)
	const rows =
		input.scopeOwnerUserId === undefined
			? await statement.all<PackageScopeGrantRow>()
			: await statement.bind(input.scopeOwnerUserId).all<PackageScopeGrantRow>()
	return rows.results ?? []
}
