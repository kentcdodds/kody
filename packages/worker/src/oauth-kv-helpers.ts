/**
 * Subset of the provider's `GrantSummary` that Kody reads. Same field names as
 * `@cloudflare/workers-oauth-provider` so callers written against the fetch
 * context helpers see identical items here.
 */
export type KvOAuthGrantSummary = {
	id: string
	clientId: string
	userId: string
	scope: Array<string>
	metadata: unknown
	createdAt: number | undefined
	expiresAt: number | undefined
	redirectUri: string | undefined
}

/**
 * Structurally satisfies `OAuthGrantHelpers` (`#worker/oauth-grants.ts`) plus
 * the `deleteClient` that account deletion uses, so it can stand in for
 * `env.OAUTH_PROVIDER` wherever those are consumed.
 */
export type KvOAuthHelpers = {
	listUserGrants(
		userId: string,
		options?: { cursor?: string; limit?: number },
	): Promise<{ items: Array<KvOAuthGrantSummary>; cursor?: string }>
	revokeGrant(grantId: string, userId: string): Promise<void>
	deleteClient(clientId: string): Promise<void>
}

const grantKeyPrefix = 'grant:'

function grantKey(userId: string, grantId: string) {
	return `${grantKeyPrefix}${userId}:${grantId}`
}

function tokenKeyPrefix(userId: string, grantId: string) {
	return `token:${userId}:${grantId}:`
}

function clientKey(clientId: string) {
	return `client:${clientId}`
}

type StoredGrant = Record<string, unknown>

function isStoredGrant(value: unknown): value is StoredGrant {
	return typeof value === 'object' && value !== null
}

function readString(record: StoredGrant, field: string) {
	const value = record[field]
	return typeof value === 'string' ? value : undefined
}

function readNumber(record: StoredGrant, field: string) {
	const value = record[field]
	return typeof value === 'number' ? value : undefined
}

/**
 * The provider writes grants at `grant:{userId}:{grantId}`; the record's own
 * `id`/`userId` fields match the key. Fall back to the key when a record is
 * missing them so a malformed grant is still revocable.
 */
function parseGrantKey(key: string) {
	if (!key.startsWith(grantKeyPrefix)) return undefined
	const separator = key.indexOf(':', grantKeyPrefix.length)
	if (separator === -1) return undefined
	const userId = key.slice(grantKeyPrefix.length, separator)
	const grantId = key.slice(separator + 1)
	if (userId.length === 0 || grantId.length === 0) return undefined
	return { userId, grantId }
}

function toGrantSummary(
	key: string,
	record: StoredGrant,
): KvOAuthGrantSummary | undefined {
	const fromKey = parseGrantKey(key)
	const id = readString(record, 'id') ?? fromKey?.grantId
	const userId = readString(record, 'userId') ?? fromKey?.userId
	if (id === undefined || userId === undefined) return undefined
	const scope = record.scope
	return {
		id,
		clientId: readString(record, 'clientId') ?? '',
		userId,
		scope: Array.isArray(scope)
			? scope.filter((entry): entry is string => typeof entry === 'string')
			: [],
		metadata: record.metadata,
		createdAt: readNumber(record, 'createdAt'),
		expiresAt: readNumber(record, 'expiresAt'),
		redirectUri: readString(record, 'redirectUri'),
	}
}

async function forEachKvPage(
	kv: KVNamespace,
	prefix: string,
	visit: (
		keys: ReadonlyArray<KVNamespaceListKey<unknown, string>>,
	) => Promise<void>,
) {
	let cursor: string | undefined
	for (;;) {
		const page = await kv.list({ prefix, cursor })
		await visit(page.keys)
		if (page.list_complete) return
		cursor = page.cursor
	}
}

/**
 * Grant/token/client operations over `OAUTH_KV` for code paths that run
 * outside the provider's `fetch` wrapper (scheduled lanes, RPC entrypoints,
 * the sessionful `MCP` Durable Object on kody-platform), where
 * `env.OAUTH_PROVIDER` is not injected. Mirrors
 * `@cloudflare/workers-oauth-provider`'s `OAuthHelpers`
 * key layout and deletion order so the resulting KV state matches a
 * fetch-context call: `revokeGrant` deletes every
 * `token:{userId}:{grantId}:*` key and then the grant key; `deleteClient`
 * revokes every grant (any user) issued to the client and then deletes
 * `client:{clientId}`. The provider keeps no secondary index keys.
 */
export function createKvOAuthHelpers(kv: KVNamespace): KvOAuthHelpers {
	async function revokeGrant(grantId: string, userId: string) {
		await forEachKvPage(kv, tokenKeyPrefix(userId, grantId), async (keys) => {
			await Promise.all(keys.map((key) => kv.delete(key.name)))
		})
		await kv.delete(grantKey(userId, grantId))
	}

	return {
		async listUserGrants(userId, options) {
			const page = await kv.list({
				prefix: `${grantKeyPrefix}${userId}:`,
				...(options?.limit !== undefined ? { limit: options.limit } : {}),
				...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
			})
			const records = await Promise.all(
				page.keys.map(async (key) => ({
					key: key.name,
					record: await kv.get(key.name, { type: 'json' }),
				})),
			)
			const items = new Array<KvOAuthGrantSummary>()
			for (const { key, record } of records) {
				if (!isStoredGrant(record)) continue
				const summary = toGrantSummary(key, record)
				if (summary) items.push(summary)
			}
			return {
				items,
				cursor: page.list_complete ? undefined : page.cursor,
			}
		},
		revokeGrant,
		async deleteClient(clientId) {
			await forEachKvPage(kv, grantKeyPrefix, async (keys) => {
				for (const key of keys) {
					const record = await kv.get(key.name, { type: 'json' })
					if (!isStoredGrant(record)) continue
					const summary = toGrantSummary(key.name, record)
					if (summary?.clientId !== clientId) continue
					await revokeGrant(summary.id, summary.userId)
				}
			})
			await kv.delete(clientKey(clientId))
		},
	}
}
