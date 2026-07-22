const oauthPurgeBatchSize = 50

export const oauthPurgeContinuationKey = 'kody:oauth-purge:continuation:v1'

type PurgePhase = 'grants' | 'tokens'

type PurgeContinuation = {
	version: 1
	nextPhase: PurgePhase
	grantCursor?: string
	tokenCursor?: string
}

type GrantRecord = {
	clientId: string
	expiresAt?: number
}

type TokenRecord = {
	grantId: string
	userId: string
}

export type OAuthPurgeResult = {
	phase: PurgePhase
	checked: number
	purged: number
	phaseComplete: boolean
}

function isPurgePhase(value: unknown): value is PurgePhase {
	return value === 'grants' || value === 'tokens'
}

function parseContinuation(value: unknown): PurgeContinuation {
	if (
		typeof value !== 'object' ||
		value === null ||
		!('version' in value) ||
		value.version !== 1 ||
		!('nextPhase' in value) ||
		!isPurgePhase(value.nextPhase)
	) {
		return { version: 1, nextPhase: 'grants' }
	}

	const grantCursor =
		'grantCursor' in value && typeof value.grantCursor === 'string'
			? value.grantCursor
			: undefined
	const tokenCursor =
		'tokenCursor' in value && typeof value.tokenCursor === 'string'
			? value.tokenCursor
			: undefined
	return {
		version: 1,
		nextPhase: value.nextPhase,
		grantCursor,
		tokenCursor,
	}
}

function isGrantRecord(value: unknown): value is GrantRecord {
	return (
		typeof value === 'object' &&
		value !== null &&
		'clientId' in value &&
		typeof value.clientId === 'string'
	)
}

function isTokenRecord(value: unknown): value is TokenRecord {
	return (
		typeof value === 'object' &&
		value !== null &&
		'grantId' in value &&
		typeof value.grantId === 'string' &&
		'userId' in value &&
		typeof value.userId === 'string'
	)
}

function isClientMetadataUrl(clientId: string) {
	try {
		const url = new URL(clientId)
		return url.protocol === 'https:' && url.pathname !== '/'
	} catch {
		return false
	}
}

async function purgeGrantPage(
	kv: KVNamespace,
	cursor: string | undefined,
	now: number,
) {
	const page = await kv.list({
		prefix: 'grant:',
		limit: oauthPurgeBatchSize,
		cursor,
	})
	const clients = new Map<string, boolean>()
	let purged = 0

	for (const key of page.keys) {
		const grant = await kv.get(key.name, { type: 'json' })
		if (!isGrantRecord(grant)) continue

		let shouldPurge =
			typeof grant.expiresAt === 'number' && now >= grant.expiresAt
		if (!shouldPurge && !isClientMetadataUrl(grant.clientId)) {
			let clientExists = clients.get(grant.clientId)
			if (clientExists === undefined) {
				clientExists =
					(await kv.get(`client:${grant.clientId}`, { type: 'json' })) !== null
				clients.set(grant.clientId, clientExists)
			}
			shouldPurge = !clientExists
		}

		if (shouldPurge) {
			// Token cleanup is deliberately left to the independently paginated token
			// phase, so a large grant cannot consume the whole cron subrequest budget.
			await kv.delete(key.name)
			purged++
		}
	}

	return {
		checked: page.keys.length,
		purged,
		phaseComplete: page.list_complete,
		cursor: page.list_complete ? undefined : page.cursor,
	}
}

async function purgeTokenPage(kv: KVNamespace, cursor: string | undefined) {
	const page = await kv.list({
		prefix: 'token:',
		limit: oauthPurgeBatchSize,
		cursor,
	})
	const grants = new Map<string, boolean>()
	let purged = 0

	for (const key of page.keys) {
		const token = await kv.get(key.name, { type: 'json' })
		if (!isTokenRecord(token)) continue

		const grantKey = `grant:${token.userId}:${token.grantId}`
		let grantExists = grants.get(grantKey)
		if (grantExists === undefined) {
			grantExists = (await kv.get(grantKey)) !== null
			grants.set(grantKey, grantExists)
		}
		if (!grantExists) {
			await kv.delete(key.name)
			purged++
		}
	}

	return {
		checked: page.keys.length,
		purged,
		phaseComplete: page.list_complete,
		cursor: page.list_complete ? undefined : page.cursor,
	}
}

/**
 * Continues one bounded OAuth KV sweep phase per invocation. The provider's
 * purgeExpiredData() cursors are invocation-local in 0.8.2, so healthy leading
 * pages otherwise starve later grants and the entire token phase.
 */
export async function continueOAuthPurge(
	env: Pick<Env, 'OAUTH_KV'>,
	now = new Date(),
): Promise<OAuthPurgeResult> {
	const continuation = parseContinuation(
		await env.OAUTH_KV.get(oauthPurgeContinuationKey, { type: 'json' }),
	)
	const phase = continuation.nextPhase

	if (phase === 'grants') {
		const result = await purgeGrantPage(
			env.OAUTH_KV,
			continuation.grantCursor,
			Math.floor(now.getTime() / 1000),
		)
		continuation.grantCursor = result.cursor
		continuation.nextPhase = 'tokens'
		await env.OAUTH_KV.put(
			oauthPurgeContinuationKey,
			JSON.stringify(continuation),
		)
		return { phase, ...result }
	}

	const result = await purgeTokenPage(env.OAUTH_KV, continuation.tokenCursor)
	continuation.tokenCursor = result.cursor
	continuation.nextPhase = 'grants'
	await env.OAUTH_KV.put(
		oauthPurgeContinuationKey,
		JSON.stringify(continuation),
	)
	return { phase, ...result }
}
