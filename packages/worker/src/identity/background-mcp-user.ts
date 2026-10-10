import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { AccountSuspendedError } from '#worker/account/account-suspension.ts'
import { getUserRolesAndPermissions } from './permissions-db.ts'
import { resolveDisplayName } from './username.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const backgroundMcpUserCacheTtlMs = 60_000
const backgroundMcpUserCacheMaxEntries = 1_000

type BackgroundMcpUserCacheEntry = {
	value: Promise<McpUserContext>
	expiresAtMs: number
}

const backgroundMcpUserCachesByDb = new WeakMap<
	D1Database,
	Map<string, BackgroundMcpUserCacheEntry>
>()

function isMissingRbacTableError(error: unknown) {
	if (!(error instanceof Error)) return false
	const message = error.message.toLowerCase()
	return (
		message.includes('no such table: user_roles') ||
		message.includes('no such table: roles') ||
		message.includes('no such table: role_permissions') ||
		message.includes('no such table: permissions')
	)
}

async function loadBackgroundMcpUser(
	db: D1Database,
	userId: string,
): Promise<McpUserContext> {
	const user = await db
		.prepare(
			`SELECT id, email, username, display_name, suspended_at
			 FROM users
			 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(userId)
		.first<{
			id: number
			email: string
			username: string
			display_name: string | null
			suspended_at: string | null
		}>()
	if (!user) {
		throw new Error(`Background MCP user was not found: ${userId}`)
	}
	if (user.suspended_at) {
		throw new AccountSuspendedError()
	}
	const profileDisplayName = user.display_name?.trim()

	// Package jobs filter the capability registry by role.
	// Omitting roles hides admin_* tools as "not found" even for admin owners.
	let roles: McpUserContext['roles'] = []
	let permissions: McpUserContext['permissions'] = []
	try {
		;({ roles, permissions } = await getUserRolesAndPermissions(db, user.id))
	} catch (error) {
		if (!isMissingRbacTableError(error)) {
			console.error('Failed to load roles for background MCP user:', error)
		}
	}
	// Some test / pre-RBAC schemas have roles + user_roles but no permission
	// tables; still surface role membership for capability filtering.
	if ((roles?.length ?? 0) === 0) {
		try {
			const roleResult = await db
				.prepare(
					`SELECT DISTINCT r.name AS role_name
					 FROM user_roles ur
					 INNER JOIN roles r ON r.id = ur.role_id
					 WHERE ur.user_id = ?`,
				)
				.bind(user.id)
				.all<{ role_name: string }>()
			roles = (roleResult.results ?? [])
				.map((row) => row.role_name)
				.filter(
					(name): name is 'user' | 'admin' =>
						name === 'user' || name === 'admin',
				)
				.sort()
		} catch (error) {
			if (!isMissingRbacTableError(error)) {
				console.error(
					'Failed to load role names for background MCP user:',
					error,
				)
			}
		}
	}

	return {
		userId: personIdFromStored(userId),
		email: user.email,
		username: user.username,
		displayName:
			profileDisplayName ||
			resolveDisplayName({
				email: user.email,
				username: user.username,
			}),
		roles,
		permissions,
	}
}

/**
 * Resolve account identity for background execution from its stable user id.
 *
 * This is the suspension choke point for background lanes (jobs, package
 * invocations and subscriptions, workflows, retrievers, realtime hooks):
 * a suspended account throws `AccountSuspendedError` instead of resolving.
 *
 * The short per-binding cache deduplicates nested and bursty package calls
 * while allowing account profile changes to propagate without isolate-wide
 * invalidation machinery, so a new suspension reaches an isolate that already
 * cached the account within the cache TTL. Rejected reads (including
 * suspension) are evicted immediately, so unsuspending takes effect at once.
 */
export async function resolveBackgroundMcpUser(
	db: D1Database,
	userId: string,
): Promise<McpUserContext> {
	let cache = backgroundMcpUserCachesByDb.get(db)
	if (!cache) {
		cache = new Map()
		backgroundMcpUserCachesByDb.set(db, cache)
	}
	const nowMs = Date.now()
	const existing = cache.get(userId)
	if (existing && existing.expiresAtMs > nowMs) {
		return await existing.value
	}
	const value = loadBackgroundMcpUser(db, userId)
	value.catch(() => {
		if (cache.get(userId)?.value === value) cache.delete(userId)
	})
	if (cache.size >= backgroundMcpUserCacheMaxEntries) {
		const oldestKey = cache.keys().next().value
		if (oldestKey !== undefined) cache.delete(oldestKey)
	}
	cache.set(userId, {
		value,
		expiresAtMs: nowMs + backgroundMcpUserCacheTtlMs,
	})
	return await value
}

export function isBackgroundMcpUserNotFoundError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.startsWith('Background MCP user was not found:')
	)
}

/**
 * Resolve the person identity for a background run keyed by an OwnerId.
 *
 * Package storage, jobs, and invoke metering use the org OwnerId. Team orgs
 * have no `users` row at that id, so prefer an explicit acting person when the
 * caller has one; otherwise fall back to a live org Owner membership after the
 * personal-org (ownerId === person id) lookup misses.
 */
export async function resolveBackgroundMcpUserForOwner(
	db: D1Database,
	input: { ownerId: string; actorUserId?: string | null },
): Promise<McpUserContext> {
	const actorUserId = input.actorUserId?.trim()
	if (actorUserId) {
		return await resolveBackgroundMcpUser(db, actorUserId)
	}
	try {
		return await resolveBackgroundMcpUser(db, input.ownerId)
	} catch (error) {
		if (!isBackgroundMcpUserNotFoundError(error)) throw error
	}
	const ownerMember = await db
		.prepare(
			`SELECT user_id
			 FROM org_memberships
			 WHERE org_id = ?
			   AND role = 'owner'
			   AND deleted_at IS NULL
			 ORDER BY created_at ASC
			 LIMIT 1`,
		)
		.bind(input.ownerId)
		.first<{ user_id: string }>()
	if (!ownerMember?.user_id) {
		throw new Error(`Background MCP user was not found: ${input.ownerId}`)
	}
	return await resolveBackgroundMcpUser(db, ownerMember.user_id)
}
