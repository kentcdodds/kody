import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { readPagination } from '#app/query-params.ts'
import { type AdminUsersLoaderData } from '#app/loader-data.ts'
import { type RoleName, roleNames } from '#app/permissions.ts'
import {
	parsePlanName,
	planNames,
	resolvePlanWrite,
	type PlanName,
} from '#worker/entitlements/plans.ts'
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'

export const adminUserListItemFieldNames = [
	'id',
	'username',
	'email',
	'email_verified',
	'email_verified_at',
	'plan',
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
	plan: PlanName | null
	created_at: string
	updated_at: string
	roles: Array<RoleName>
}

const defaultPageSize = 20
const maxPageSize = 100

type AdminUserListFilters = {
	query: string
	role: RoleName | null
}

/** Read the `q` and `role` filter query params shared by the page and API. */
function readAdminUserListFilters(url: URL): AdminUserListFilters {
	const rawRole = url.searchParams.get('role')?.trim() ?? ''
	return {
		query: url.searchParams.get('q')?.trim() ?? '',
		role: isRoleName(rawRole) ? rawRole : null,
	}
}

function escapeLikePattern(value: string) {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * Build the WHERE clause shared by the page query and its COUNT so the
 * reported total always matches the filtered result set.
 */
function buildAdminUserListWhereClause(filters: AdminUserListFilters) {
	const conditions: Array<string> = []
	const params: Array<string> = []
	if (filters.query) {
		const pattern = `%${escapeLikePattern(filters.query)}%`
		conditions.push(`(username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')`)
		params.push(pattern, pattern)
	}
	if (filters.role) {
		conditions.push(
			`id IN (SELECT ur.user_id FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE r.name = ?)`,
		)
		params.push(filters.role)
	}
	return {
		whereClause:
			conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
		params,
	}
}

export async function loadAdminUsersData(
	env: Env,
	requestUrl: string,
): Promise<AdminUsersLoaderData> {
	const url = new URL(requestUrl, 'http://localhost')
	const { page, pageSize, offset } = readPagination(url, {
		defaultPageSize,
		maxPageSize,
	})
	const filters = readAdminUserListFilters(url)
	const { whereClause, params } = buildAdminUserListWhereClause(filters)

	const [totalResult, userRows] = await Promise.all([
		env.APP_DB.prepare(`SELECT COUNT(*) AS total FROM users ${whereClause}`)
			.bind(...params)
			.first<{ total: number }>(),
		env.APP_DB.prepare(
			`SELECT id, username, email, email_verified_at, plan, created_at, updated_at
			 FROM users
			 ${whereClause}
			 ORDER BY id ASC
			 LIMIT ? OFFSET ?`,
		)
			.bind(...params, pageSize, offset)
			.all<AdminUserRow>(),
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
		availablePlans: [...planNames],
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
					`SELECT id, username, email, email_verified_at, plan, created_at, updated_at
					 FROM users
					 WHERE id = ?`,
				)
				.bind(input.id)
				.first<AdminUserRow>()
		: email
			? await db
					.prepare(
						`SELECT id, username, email, email_verified_at, plan, created_at, updated_at
						 FROM users
						 WHERE email = ? COLLATE NOCASE`,
					)
					.bind(email)
					.first<AdminUserRow>()
			: null
	if (!userRow) return null

	const rolesByUserId = await loadRolesByUserIds(db, [userRow.id])
	return toAdminUserListItem(userRow, rolesByUserId.get(userRow.id) ?? [])
}

/**
 * Set the entitlement plan on one user account. Nullish inputs map to the
 * first-class `unlimited` plan; writers never persist NULL. Returns the
 * updated account metadata record, or null when no user matches `id`/`email`.
 */
export async function updateAdminUserPlan(
	db: D1Database,
	input: { id?: number; email?: string; plan: PlanName | null },
): Promise<AdminUserListItem | null> {
	const existing = await loadAdminUserByIdOrEmail(db, input)
	if (!existing) return null

	await db
		.prepare(`UPDATE users SET plan = ?, updated_at = ? WHERE id = ?`)
		.bind(resolvePlanWrite(input.plan), utcSqliteTimestamp(), existing.id)
		.run()

	return loadAdminUserByIdOrEmail(db, { id: existing.id })
}

export async function loadRolesByUserIds(
	db: D1Database,
	userIds: Array<number>,
) {
	const rolesByUserId = new Map<number, Array<RoleName>>()
	if (userIds.length === 0) {
		return rolesByUserId
	}

	// A 100-user admin page hits D1's per-statement bound parameter cap, so
	// split the IN list across statements.
	for (const chunk of chunkArray(userIds, maxD1BoundParameters)) {
		const placeholders = chunk.map(() => '?').join(', ')
		const result = await db
			.prepare(
				`SELECT ur.user_id, r.name AS role_name
				 FROM user_roles ur
				 INNER JOIN roles r ON r.id = ur.role_id
				 WHERE ur.user_id IN (${placeholders})
				 ORDER BY ur.user_id ASC, r.name ASC`,
			)
			.bind(...chunk)
			.all<{ user_id: number; role_name: string }>()

		for (const row of result.results ?? []) {
			if (!isRoleName(row.role_name)) continue
			const current = rolesByUserId.get(row.user_id) ?? []
			current.push(row.role_name)
			rolesByUserId.set(row.user_id, current)
		}
	}

	return rolesByUserId
}

type AdminUserRow = {
	id: number
	username: string
	email: string
	email_verified_at: string | null
	plan: string | null
	created_at: string
	updated_at: string
}

function toAdminUserListItem(
	row: AdminUserRow,
	roles: Array<RoleName>,
): AdminUserListItem {
	return {
		id: row.id,
		username: row.username,
		email: row.email,
		email_verified: Boolean(row.email_verified_at),
		email_verified_at: row.email_verified_at,
		plan: parsePlanName(row.plan),
		created_at: row.created_at,
		updated_at: row.updated_at,
		roles,
	}
}

function isRoleName(value: string): value is RoleName {
	return (roleNames as ReadonlyArray<string>).includes(value)
}
