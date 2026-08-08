import { type McpUserContext } from '@kody-internal/shared/chat.ts'
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

async function loadBackgroundMcpUser(
	db: D1Database,
	userId: string,
): Promise<McpUserContext> {
	const user = await db
		.prepare(
			`SELECT email, username, display_name
			 FROM users
			 WHERE stable_user_id = ?`,
		)
		.bind(userId)
		.first<{
			email: string
			username: string
			display_name: string | null
		}>()
	if (!user) {
		throw new Error(`Background MCP user was not found: ${userId}`)
	}
	const profileDisplayName = user.display_name?.trim()
	return {
		userId,
		email: user.email,
		username: user.username,
		displayName:
			profileDisplayName ||
			resolveDisplayName({
				email: user.email,
				username: user.username,
			}),
	}
}

/**
 * Resolve account identity for background execution from its stable user id.
 *
 * The short per-binding cache deduplicates nested and bursty package calls
 * while allowing account profile changes to propagate without isolate-wide
 * invalidation machinery. Rejected reads are evicted immediately.
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
