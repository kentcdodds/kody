/**
 * Package scope grants: explicit rows that let a person account act inside a
 * platform account's package scope (for example `@kody/*`).
 *
 * Grants are only representable on platform accounts (`users.account_type =
 * 'platform'`). Person accounts can never be the target of a grant, so
 * "act as another user" is structurally unrepresentable — enforced in
 * `insertPackageScopeGrant` and re-checked at resolution time in
 * `package-owner.ts`.
 */

export type PackageScopeGrantRow = {
	scope_owner_user_id: number
	grantee_user_id: number
	created_by_user_id: number
	created_at: string
	scope_username: string
	grantee_username: string
}

type UserAccountRow = {
	id: number
	username: string
	email: string
	account_type: string
	stable_user_id: string | null
}

const userAccountSelect = `SELECT id, username, email, account_type, stable_user_id FROM users`

export async function getPlatformAccountByUsername(
	db: D1Database,
	username: string,
): Promise<UserAccountRow | null> {
	const row = await db
		.prepare(`${userAccountSelect} WHERE username = ? LIMIT 1`)
		.bind(username)
		.first<UserAccountRow>()
	if (!row || row.account_type !== 'platform') return null
	return row
}

export async function hasPackageScopeGrant(
	db: D1Database,
	input: {
		scopeOwnerUserId: number
		granteeUserId: number
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
		scopeOwnerUserId: number
		granteeUserId: number
		createdByUserId: number
	},
): Promise<{ created: boolean }> {
	const scopeOwner = await db
		.prepare(`SELECT account_type FROM users WHERE id = ? LIMIT 1`)
		.bind(input.scopeOwnerUserId)
		.first<{ account_type: string }>()
	if (scopeOwner?.account_type !== 'platform') {
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
		scopeOwnerUserId: number
		granteeUserId: number
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
		scopeOwnerUserId?: number
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
		INNER JOIN users AS scope_users ON scope_users.id = grants.scope_owner_user_id
		INNER JOIN users AS grantee_users ON grantee_users.id = grants.grantee_user_id
		${where}
		ORDER BY grants.created_at ASC`,
	)
	const rows =
		input.scopeOwnerUserId === undefined
			? await statement.all<PackageScopeGrantRow>()
			: await statement.bind(input.scopeOwnerUserId).all<PackageScopeGrantRow>()
	return rows.results ?? []
}
