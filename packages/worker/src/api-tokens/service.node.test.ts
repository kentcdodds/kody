import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	parseApiToken,
	redactApiTokens,
} from '@kody-internal/shared/api-token-format.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { apiTokenScopeIncludes } from './scopes.ts'
import {
	apiTokenLifetimeAliases,
	apiTokenPolicy,
	authenticateApiToken,
	getApiTokenRecord,
	listApiTokens,
	mintApiToken,
	resolveApiTokenLifetime,
	revokeApiToken,
	rotateApiToken,
	slideApiTokenExpiry,
	touchApiToken,
} from './service.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const userId = 'stable-user-1'
const start = new Date('2026-09-30T12:00:00.000Z')
const shortLife = apiTokenLifetimeAliases.short

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function at(seconds: number) {
	return new Date(start.getTime() + seconds * 1000)
}

function rejection(promise: Promise<unknown>) {
	return promise.then(
		() => null,
		(thrown: unknown) => thrown,
	)
}

test('mint returns the plaintext once, stores only a hash, and authenticates', async () => {
	const { sqlite, db } = createDb()
	const minted = await mintApiToken({
		db,
		userId,
		name: '  cli  ',
		scopes: ['package:read', 'secret:use', 'package:read'],
		idleTtlSeconds: shortLife.idleTtlSeconds,
		maxLifetimeSeconds: shortLife.maxLifetimeSeconds,
		createdVia: 'api',
		now: start,
	})

	expect(minted).toMatchObject({
		name: 'cli',
		scopes: ['package:read', 'secret:use'],
		status: 'active',
		token_type: 'Bearer',
		idle_ttl_seconds: shortLife.idleTtlSeconds,
		expires_at: at(shortLife.idleTtlSeconds).toISOString(),
		max_expires_at: at(shortLife.maxLifetimeSeconds).toISOString(),
	})
	const parsed = parseApiToken(minted.token)
	expect(parsed?.tokenId).toBe(minted.id)
	const stored = sqlite
		.prepare(`SELECT token_hash FROM api_tokens WHERE id = ?`)
		.get(minted.id) as { token_hash: string }
	expect(stored.token_hash).not.toContain(parsed?.secret)
	expect(redactApiTokens(`Bearer ${minted.token}`)).toBe(
		'Bearer kody_at_[redacted]',
	)

	const auth = await authenticateApiToken({
		db,
		token: minted.token,
		now: at(60),
	})
	expect(auth.ok && auth.record.user_id).toBe(userId)

	const listed = await listApiTokens({ db, userId, now: at(60) })
	expect(listed).toHaveLength(1)
	expect(JSON.stringify(listed)).not.toContain(parsed?.secret)
	expect(JSON.stringify(listed)).not.toContain(stored.token_hash)
})

test('resolveApiTokenLifetime rejects prototype keys as aliases', () => {
	expect(() => resolveApiTokenLifetime({ lifetime: 'toString' })).toThrow(
		/lifetime must be "short" or "long"/,
	)
})

test('authentication rejects malformed, wrong-secret, expired, and revoked tokens', async () => {
	const { db } = createDb()
	const minted = await mintApiToken({
		db,
		userId,
		name: 'short',
		scopes: ['org:read'],
		idleTtlSeconds: 60,
		maxLifetimeSeconds: 60,
		createdVia: 'api',
		now: start,
	})
	const parsed = parseApiToken(minted.token)!
	const wrongSecret = `kody_at_${parsed.tokenId}_${'A'.repeat(43)}`

	expect(await authenticateApiToken({ db, token: 'nope' })).toEqual({
		ok: false,
		reason: 'malformed',
	})
	expect(
		await authenticateApiToken({ db, token: wrongSecret, now: at(1) }),
	).toEqual({ ok: false, reason: 'unknown' })
	expect(
		await authenticateApiToken({ db, token: minted.token, now: at(61) }),
	).toMatchObject({ ok: false, reason: 'expired', record: { id: minted.id } })

	expect(await revokeApiToken({ db, userId, tokenId: minted.id })).toBe(true)
	expect(
		await authenticateApiToken({ db, token: minted.token, now: at(1) }),
	).toMatchObject({ ok: false, reason: 'revoked', record: { id: minted.id } })
	expect(await revokeApiToken({ db, userId, tokenId: minted.id })).toBe(false)
})

test('use slides expiry forward, debounced, and never past the absolute expiry', async () => {
	const { db } = createDb()
	const minted = await mintApiToken({
		db,
		userId,
		name: 'sliding',
		scopes: ['job:read'],
		idleTtlSeconds: 300,
		maxLifetimeSeconds: 600,
		createdVia: 'api',
		now: start,
	})
	const load = async () =>
		(await getApiTokenRecord({ db, userId, tokenId: minted.id }))!
	const touch = async (seconds: number) => {
		const slid = slideApiTokenExpiry(await load(), at(seconds))
		return slid ? touchApiToken({ db, record: slid }) : false
	}

	expect(await touch(200)).toBe(true)
	expect((await load()).expires_at).toBe(at(500).toISOString())
	expect((await load()).last_used_at).toBe(at(200).toISOString())

	expect(await touch(230)).toBe(false)

	expect(await touch(450)).toBe(true)
	expect((await load()).expires_at).toBe(at(600).toISOString())
	expect(
		await authenticateApiToken({ db, token: minted.token, now: at(601) }),
	).toMatchObject({ ok: false, reason: 'expired' })
})

test('a token used at its minimum idle TTL keeps at least three quarters of it', async () => {
	const { db } = createDb()
	const minted = await mintApiToken({
		db,
		userId,
		name: 'minimum',
		scopes: ['job:read'],
		idleTtlSeconds: apiTokenPolicy.minIdleTtlSeconds,
		maxLifetimeSeconds: apiTokenLifetimeAliases.short.maxLifetimeSeconds,
		createdVia: 'api',
		now: start,
	})
	let record = (await getApiTokenRecord({ db, userId, tokenId: minted.id }))!
	for (let seconds = 5; seconds <= 600; seconds += 5) {
		const slid = slideApiTokenExpiry(record, at(seconds))
		if (slid) {
			await touchApiToken({ db, record: slid })
			record = slid
		}
		expect(
			Date.parse(record.expires_at) - at(seconds).getTime(),
		).toBeGreaterThanOrEqual(apiTokenPolicy.minIdleTtlSeconds * 750)
	}
	expect(
		await authenticateApiToken({ db, token: minted.token, now: at(601) }),
	).toMatchObject({ ok: true })
})

test('rotate invalidates the old secret and keeps scopes and absolute expiry', async () => {
	const { db } = createDb()
	const minted = await mintApiToken({
		db,
		userId,
		name: 'rotating',
		scopes: ['job:write'],
		idleTtlSeconds: shortLife.idleTtlSeconds,
		maxLifetimeSeconds: shortLife.maxLifetimeSeconds,
		createdVia: 'mcp-api',
		now: start,
	})
	const rotated = await rotateApiToken({
		db,
		userId,
		tokenId: minted.id,
		now: at(30),
	})

	expect(rotated).toMatchObject({
		id: minted.id,
		scopes: ['job:write'],
		max_expires_at: minted.max_expires_at,
		rotated_at: at(30).toISOString(),
	})
	expect(rotated?.token).not.toBe(minted.token)
	expect(
		await authenticateApiToken({ db, token: minted.token, now: at(31) }),
	).toMatchObject({ ok: false, reason: 'unknown' })
	const auth = await authenticateApiToken({
		db,
		token: rotated!.token,
		now: at(31),
	})
	expect(auth.ok).toBe(true)
	expect(
		await rotateApiToken({ db, userId: 'someone-else', tokenId: minted.id }),
	).toBeNull()
})

test('mint validates scopes, ttl bounds, org:execute access, and parent limits', async () => {
	const { db } = createDb()
	const base = {
		db,
		userId,
		name: 'bad',
		idleTtlSeconds: shortLife.idleTtlSeconds,
		maxLifetimeSeconds: shortLife.maxLifetimeSeconds,
		createdVia: 'api' as const,
		now: start,
	}

	expect(
		await rejection(mintApiToken({ ...base, scopes: ['packages:admin'] })),
	).toBeInstanceOf(McpCallerError)
	expect(await rejection(mintApiToken({ ...base, scopes: [] }))).toBeInstanceOf(
		McpCallerError,
	)
	expect(
		await rejection(
			mintApiToken({
				...base,
				scopes: ['job:read'],
				idleTtlSeconds: 5,
				maxLifetimeSeconds: 60,
			}),
		),
	).toBeInstanceOf(McpCallerError)
	const localExecute = await mintApiToken({
		...base,
		scopes: ['org:execute'],
	})
	expect(localExecute.scopes).toEqual(['org:execute'])

	const parent = {
		scopes: ['package:write', 'token:delete'] as const,
		maxExpiresAt: at(3600).toISOString(),
	}
	expect(
		await rejection(mintApiToken({ ...base, scopes: ['secret:use'], parent })),
	).toBeInstanceOf(McpCallerError)
	const child = await mintApiToken({
		...base,
		scopes: ['package:write'],
		parent,
	})
	expect(child.max_expires_at).toBe(at(3600).toISOString())
})

test('at the active-token cap, mint reclaims the soonest-to-expire token', async () => {
	const { db } = createDb()
	const base = {
		db,
		userId,
		scopes: ['org:read'] as const,
		createdVia: 'api' as const,
		now: start,
	}
	const longLife = apiTokenLifetimeAliases.long
	const mintedIds: Array<string> = []
	for (
		let index = 0;
		index < apiTokenPolicy.maxActiveTokensPerUser - 1;
		index++
	) {
		const minted = await mintApiToken({
			...base,
			name: `bulk-${index}`,
			idleTtlSeconds: longLife.idleTtlSeconds,
			maxLifetimeSeconds: longLife.maxLifetimeSeconds,
		})
		mintedIds.push(minted.id)
	}
	const soonest = await mintApiToken({
		...base,
		name: 'soonest',
		idleTtlSeconds: 60,
		maxLifetimeSeconds: 120,
	})
	mintedIds.push(soonest.id)

	const next = await mintApiToken({
		...base,
		name: 'after-cap',
		idleTtlSeconds: shortLife.idleTtlSeconds,
		maxLifetimeSeconds: shortLife.maxLifetimeSeconds,
		now: at(1),
	})
	expect(next.status).toBe('active')
	expect(
		await getApiTokenRecord({ db, userId, tokenId: soonest.id }),
	).toMatchObject({ revoked_at: at(1).toISOString() })
	const active = await listApiTokens({ db, userId, now: at(1) })
	expect(active).toHaveLength(apiTokenPolicy.maxActiveTokensPerUser)
	expect(active.some((token) => token.id === soonest.id)).toBe(false)
	expect(active.some((token) => token.id === next.id)).toBe(true)
})

test('reclaim never revokes the caller token even when it is soonest to expire', async () => {
	const { db } = createDb()
	const caller = await mintApiToken({
		db,
		userId,
		name: 'caller',
		scopes: ['token:delete', 'org:read'],
		idleTtlSeconds: 60,
		maxLifetimeSeconds: 120,
		createdVia: 'api',
		now: start,
	})
	for (
		let index = 0;
		index < apiTokenPolicy.maxActiveTokensPerUser - 1;
		index++
	) {
		await mintApiToken({
			db,
			userId,
			name: `other-${index}`,
			scopes: ['org:read'],
			idleTtlSeconds: apiTokenLifetimeAliases.long.idleTtlSeconds,
			maxLifetimeSeconds: apiTokenLifetimeAliases.long.maxLifetimeSeconds,
			createdVia: 'api',
			now: start,
		})
	}

	const next = await mintApiToken({
		db,
		userId,
		name: 'protected-mint',
		scopes: ['org:read'],
		idleTtlSeconds: shortLife.idleTtlSeconds,
		maxLifetimeSeconds: shortLife.maxLifetimeSeconds,
		createdVia: 'api',
		excludeTokenId: caller.id,
		now: at(1),
	})
	expect(next.status).toBe('active')
	expect(
		await getApiTokenRecord({ db, userId, tokenId: caller.id }),
	).toMatchObject({ revoked_at: null })
	const active = await listApiTokens({ db, userId, now: at(1) })
	expect(active.some((token) => token.id === caller.id)).toBe(true)
	expect(active).toHaveLength(apiTokenPolicy.maxActiveTokensPerUser)
})

test('reclaim ranks by expires_at so a recently rotated token is not preferred', async () => {
	const { db } = createDb()
	const longLife = apiTokenLifetimeAliases.long
	for (
		let index = 0;
		index < apiTokenPolicy.maxActiveTokensPerUser - 2;
		index++
	) {
		await mintApiToken({
			db,
			userId,
			name: `bulk-${index}`,
			scopes: ['org:read'],
			idleTtlSeconds: longLife.idleTtlSeconds,
			maxLifetimeSeconds: longLife.maxLifetimeSeconds,
			createdVia: 'api',
			now: start,
		})
	}
	const aged = await mintApiToken({
		db,
		userId,
		name: 'aged-then-rotated',
		scopes: ['org:read'],
		idleTtlSeconds: 60,
		maxLifetimeSeconds: 24 * 60 * 60,
		createdVia: 'api',
		now: start,
	})
	const soon = await mintApiToken({
		db,
		userId,
		name: 'soon',
		scopes: ['org:read'],
		idleTtlSeconds: 60,
		maxLifetimeSeconds: 90,
		createdVia: 'api',
		now: start,
	})
	// Rotation slides expires_at to now+idle (110s). The old created_at+idle
	// formula would still rank this token first; expires_at ranking must not.
	const rotated = await rotateApiToken({
		db,
		userId,
		tokenId: aged.id,
		now: at(50),
	})
	expect(rotated?.expires_at).toBe(at(110).toISOString())

	const next = await mintApiToken({
		db,
		userId,
		name: 'after-cap',
		scopes: ['org:read'],
		idleTtlSeconds: shortLife.idleTtlSeconds,
		maxLifetimeSeconds: shortLife.maxLifetimeSeconds,
		createdVia: 'api',
		now: at(51),
	})
	expect(next.status).toBe('active')
	expect(
		await getApiTokenRecord({ db, userId, tokenId: soon.id }),
	).toMatchObject({ revoked_at: at(51).toISOString() })
	expect(
		await getApiTokenRecord({ db, userId, tokenId: aged.id }),
	).toMatchObject({ revoked_at: null })
})

test('mint prunes long-dead rows before reclaim', async () => {
	const { sqlite, db } = createDb()
	const base = {
		db,
		userId,
		name: 'bulk',
		scopes: ['org:read'],
		idleTtlSeconds: 60,
		maxLifetimeSeconds: 120,
		createdVia: 'api' as const,
	}
	for (let index = 0; index < 3; index++) {
		await mintApiToken({ ...base, name: `dead-${index}`, now: start })
	}

	const later = at(apiTokenPolicy.inactiveRetentionSeconds + 2 * 86_400)
	await mintApiToken({
		...base,
		name: 'survivor',
		idleTtlSeconds: shortLife.idleTtlSeconds,
		maxLifetimeSeconds: shortLife.maxLifetimeSeconds,
		now: later,
	})
	const remaining = sqlite
		.prepare(`SELECT COUNT(*) AS count FROM api_tokens WHERE user_id = ?`)
		.get(userId) as { count: number }
	expect(remaining.count).toBe(1)
})

test('org-permission scopes do not imply a write-to-read hierarchy', () => {
	expect(apiTokenScopeIncludes(['package:write'], 'package:read')).toBe(false)
	expect(apiTokenScopeIncludes(['package:read'], 'package:write')).toBe(false)
	expect(apiTokenScopeIncludes(['secret:write'], 'package:read')).toBe(false)
	expect(apiTokenScopeIncludes(['org:execute'], 'org:execute')).toBe(true)
})
