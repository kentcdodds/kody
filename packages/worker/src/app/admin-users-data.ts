import { type AdminUsersLoaderData } from '#app/loader-data.ts'
import { type RoleName, roleNames } from '#app/permissions.ts'

export const adminUserListItemFieldNames = [
	'id',
	'username',
	'email',
	'email_verified',
	'email_verified_at',
	'created_at',
	'updated_at',
	'roles',
] as const

export type AdminUserListItemFieldName =
	(typeof adminUserListItemFieldNames)[number]

export type AdminUserListItem = Record<AdminUserListItemFieldName, unknown> & {
	id: number
	username: string
	email: string
	email_verified: boolean
	email_verified_at: string | null
	created_at: string
	updated_at: string
	roles: Array<RoleName>
}

const defaultPageSize = 20
const maxPageSize = 100

export async function loadAdminUsersData(
	env: Env,
	requestUrl: string,
): Promise<AdminUsersLoaderData> {
	const url = new URL(requestUrl, 'http://localhost')
	const page = readPositiveInt(url.searchParams.get('page'), 1)
	const pageSize = Math.min(
		readPositiveInt(url.searchParams.get('pageSize'), defaultPageSize),
		maxPageSize,
	)
	const offset = (page - 1) * pageSize

	const [totalResult, userRows] = await Promise.all([
		env.APP_DB.prepare(`SELECT COUNT(*) AS total FROM users`).first<{
			total: number
		}>(),
		env.APP_DB.prepare(
			`SELECT id, username, email, email_verified_at, created_at, updated_at
			 FROM users
			 ORDER BY id ASC
			 LIMIT ? OFFSET ?`,
		)
			.bind(pageSize, offset)
			.all<{
				id: number
				username: string
				email: string
				email_verified_at: string | null
				created_at: string
				updated_at: string
			}>(),
	])
	const total = totalResult?.total ?? 0

	const userIds = (userRows.results ?? []).map((row) => row.id)
	const rolesByUserId = await loadRolesByUserIds(env.APP_DB, userIds)

	return {
		ok: true,
		users: (userRows.results ?? []).map((row) =>
			toAdminUserListItem(row, rolesByUserId.get(row.id) ?? []),
		),
		page,
		pageSize,
		total,
		availableRoles: [...roleNames],
	}
}

export async function loadAdminUserByIdOrEmail(
	db: D1Database,
	input: { id?: number; email?: string },
): Promise<AdminUserListItem | null> {
	const email = input.email?.trim() ?? ''
	const userRow = input.id
		? await db
				.prepare(
					`SELECT id, username, email, email_verified_at, created_at, updated_at
					 FROM users
					 WHERE id = ?`,
				)
				.bind(input.id)
				.first<{
					id: number
					username: string
					email: string
					email_verified_at: string | null
					created_at: string
					updated_at: string
				}>()
		: email
			? await db
					.prepare(
						`SELECT id, username, email, email_verified_at, created_at, updated_at
						 FROM users
						 WHERE email = ? COLLATE NOCASE`,
					)
					.bind(email)
					.first<{
						id: number
						username: string
						email: string
						email_verified_at: string | null
						created_at: string
						updated_at: string
					}>()
			: null
	if (!userRow) return null

	const rolesByUserId = await loadRolesByUserIds(db, [userRow.id])
	return toAdminUserListItem(userRow, rolesByUserId.get(userRow.id) ?? [])
}

export async function loadRolesByUserIds(
	db: D1Database,
	userIds: Array<number>,
) {
	const rolesByUserId = new Map<number, Array<RoleName>>()
	if (userIds.length === 0) {
		return rolesByUserId
	}

	const placeholders = userIds.map(() => '?').join(', ')
	const result = await db
		.prepare(
			`SELECT ur.user_id, r.name AS role_name
			 FROM user_roles ur
			 INNER JOIN roles r ON r.id = ur.role_id
			 WHERE ur.user_id IN (${placeholders})
			 ORDER BY ur.user_id ASC, r.name ASC`,
		)
		.bind(...userIds)
		.all<{ user_id: number; role_name: string }>()

	for (const row of result.results ?? []) {
		if (!isRoleName(row.role_name)) continue
		const current = rolesByUserId.get(row.user_id) ?? []
		current.push(row.role_name)
		rolesByUserId.set(row.user_id, current)
	}

	return rolesByUserId
}

function toAdminUserListItem(
	row: {
		id: number
		username: string
		email: string
		email_verified_at: string | null
		created_at: string
		updated_at: string
	},
	roles: Array<RoleName>,
): AdminUserListItem {
	return {
		id: row.id,
		username: row.username,
		email: row.email,
		email_verified: Boolean(row.email_verified_at),
		email_verified_at: row.email_verified_at,
		created_at: row.created_at,
		updated_at: row.updated_at,
		roles,
	}
}

function isRoleName(value: string): value is RoleName {
	return (roleNames as ReadonlyArray<string>).includes(value)
}

function readPositiveInt(value: string | null, fallback: number) {
	if (!value) return fallback
	const parsed = Number.parseInt(value, 10)
	if (!Number.isFinite(parsed) || parsed < 1) {
		return fallback
	}
	return parsed
}
