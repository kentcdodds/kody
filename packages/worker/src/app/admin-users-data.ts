import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { readPagination } from '#app/query-params.ts'
import { type AdminUsersLoaderData } from '#app/loader-data.ts'
import { type RoleName, roleNames } from '#app/permissions.ts'
import {
	parseStoredPlanName,
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
	'suspended_at',
	'email_outbound_paused_at',
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
	plan: PlanName
	suspended_at: string | null
	email_outbound_paused_at: string | null
	created_at: string
	updated_at: string
	roles: Array<RoleName>
}

const adminUsersBasePath = '/admin/users'
const defaultPageSize = 20
const maxPageSize = 100

type AdminUserListFilters = {
	query: string
	role: RoleName | null
}

/**
 * Resolve the selected account id from an HTML path param, a detail
 * pathname, or the JSON API's `?selected=` query (in that order). Invalid
 * / non-numeric values yield null so the client can show "User not found."
 */
export function readAdminUsersSelectedUserId(
	requestUrl: string,
	pathUserId?: string,
): number | null {
	const fromPathParam = parseSelectedUserId(pathUserId)
	if (fromPathParam != null) return fromPathParam

	const url = new URL(requestUrl, 'http://localhost')
	const detailPrefix = `${adminUsersBasePath}/`
	if (url.pathname.startsWith(detailPrefix)) {
		const segment = decodePathSegment(url.pathname.slice(detailPrefix.length))
		if (segment && !segment.includes('/')) {
			const fromPath = parseSelectedUserId(segment)
			if (fromPath != null) return fromPath
		}
	}

	return parseSelectedUserId(url.searchParams.get('selected'))
}

function decodePathSegment(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		// Malformed percent-encoding (e.g. a literal `%`) must not throw;
		// the raw segment simply fails numeric parsing below.
		return value
	}
}

function parseSelectedUserId(value: string | null | undefined): number | null {
	if (!value?.trim()) return null
	const trimmed = value.trim()
	const parsed = Number.parseInt(trimmed, 10)
	if (!Number.isFinite(parsed) || parsed < 1) return null
	// Reject leftovers like "12abc" / "usage.json" so only pure numeric ids
	// resolve; unknown ids still load as null from the database below.
	if (String(parsed) !== trimmed) return null
	return parsed
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
	pathUserId?: string,
): Promise<AdminUsersLoaderData> {
	const url = new URL(requestUrl, 'http://localhost')
	const { page, pageSize, offset } = readPagination(url, {
		defaultPageSize,
		maxPageSize,
	})
	const filters = readAdminUserListFilters(url)
	const { whereClause, params } = buildAdminUserListWhereClause(filters)
	const selectedUserId = readAdminUsersSelectedUserId(requestUrl, pathUserId)

	const [totalResult, userRows, selectedUser] = await Promise.all([
		env.APP_DB.prepare(`SELECT COUNT(*) AS total FROM users ${whereClause}`)
			.bind(...params)
			.first<{ total: number }>(),
		env.APP_DB.prepare(
			`SELECT id, username, email, email_verified_at, plan, suspended_at,
				email_outbound_paused_at, created_at, updated_at
			 FROM users
			 ${whereClause}
			 ORDER BY id ASC
			 LIMIT ? OFFSET ?`,
		)
			.bind(...params, pageSize, offset)
			.all<AdminUserRow>(),
		selectedUserId
			? loadAdminUserByIdOrEmail(env.APP_DB, { id: selectedUserId })
			: Promise.resolve(null),
	])
	const total = totalResult?.total ?? 0

	const userIds = (userRows.results ?? []).map((row) => row.id)
	const rolesByUserId = await loadRolesByUserIds(env.APP_DB, userIds)

	return {
		ok: true,
		users: (userRows.results ?? []).map((row) =>
			toAdminUserListItem(row, rolesByUserId.get(row.id) ?? []),
		),
		selectedUser,
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
					`SELECT id, username, email, email_verified_at, plan, suspended_at,
						email_outbound_paused_at, created_at, updated_at
					 FROM users
					 WHERE id = ?`,
				)
				.bind(input.id)
				.first<AdminUserRow>()
		: email
			? await db
					.prepare(
						`SELECT id, username, email, email_verified_at, plan, suspended_at,
							email_outbound_paused_at, created_at, updated_at
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
 * Set the entitlement plan on one user account. Nullish inputs map to `free`,
 * the normal default plan; writers never persist NULL. Returns the updated
 * account metadata record, or null when no user matches `id`/`email`.
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

/**
 * Set or clear the platform suspension on one user account. Suspension is
 * fail-closed at the browser-session, MCP, and email chokepoints; clearing
 * it restores normal access on the next request. Returns the updated
 * account metadata record, or null when no user matches `id`.
 */
export async function updateAdminUserSuspension(
	db: D1Database,
	input: { id: number; suspended: boolean },
): Promise<AdminUserListItem | null> {
	const existing = await loadAdminUserByIdOrEmail(db, { id: input.id })
	if (!existing) return null

	const now = utcSqliteTimestamp()
	await db
		.prepare(`UPDATE users SET suspended_at = ?, updated_at = ? WHERE id = ?`)
		.bind(input.suspended ? now : null, now, existing.id)
		.run()

	return loadAdminUserByIdOrEmail(db, { id: existing.id })
}

/**
 * Clear an automatic outbound-email pause (set by the delivery-event abuse
 * monitor) after operator review. Returns the updated account metadata
 * record, or null when no user matches `id`.
 */
export async function clearAdminUserEmailOutboundPause(
	db: D1Database,
	input: { id: number },
): Promise<AdminUserListItem | null> {
	const existing = await loadAdminUserByIdOrEmail(db, { id: input.id })
	if (!existing) return null

	await db
		.prepare(
			`UPDATE users SET email_outbound_paused_at = NULL, updated_at = ? WHERE id = ?`,
		)
		.bind(utcSqliteTimestamp(), existing.id)
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
	plan: string
	suspended_at: string | null
	email_outbound_paused_at: string | null
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
		plan: parseStoredPlanName(row.plan),
		suspended_at: row.suspended_at,
		email_outbound_paused_at: row.email_outbound_paused_at,
		created_at: row.created_at,
		updated_at: row.updated_at,
		roles,
	}
}

function isRoleName(value: string): value is RoleName {
	return (roleNames as ReadonlyArray<string>).includes(value)
}
