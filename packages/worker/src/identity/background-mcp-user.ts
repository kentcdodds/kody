/**
 * soft-delete-read-filter: opt-out — person lookup reads `users.deleted_at`
 * so a tombstoned person cannot fall through to a leftover personal org row.
 */
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { AccountSuspendedError } from '#worker/account/account-suspension.ts'
import { getOrgById } from '#worker/orgs/repo.ts'
import { getUserRolesAndPermissions } from './permissions-db.ts'
import { resolveDisplayName } from './username.ts'

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

function backgroundMcpUserNotFound(userId: string) {
	return new Error(`Background MCP user was not found: ${userId}`)
}

/**
 * Person accounts and team orgs share the owner-id space that package job
 * sync and saved-package projection pass into this lookup. A live team org
 * (no `users` row) still needs a caller identity. A person id still wins: a
 * deleting or soft-deleted user is missing even when a personal org remains.
 */
async function loadBackgroundMcpUser(
	db: D1Database,
	userId: string,
): Promise<McpUserContext> {
	const user = await db
		.prepare(
			`SELECT id, email, username, display_name, suspended_at,
				deleting_at, deleted_at
			 FROM users
			 WHERE stable_user_id = ?`,
		)
		.bind(userId)
		.first<{
			id: number
			email: string
			username: string
			display_name: string | null
			suspended_at: string | null
			deleting_at: string | null
			deleted_at: string | null
		}>()
	if (user) {
		if (user.deleting_at || user.deleted_at) {
			throw backgroundMcpUserNotFound(userId)
		}
		if (user.suspended_at) {
			throw new AccountSuspendedError()
		}
	} else {
		const org = await getOrgById(db, userId)
		if (!org) {
			throw backgroundMcpUserNotFound(userId)
		}
		const displayName = org.display_name?.trim() || org.slug
		return {
			userId: personIdFromStored(userId),
			email: '',
			username: org.slug,
			displayName,
			roles: ['user'],
			permissions: [],
		}
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
 * Resolve account identity for background execution from its stable user id
 * or a live team org id in the same owner-id space.
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
