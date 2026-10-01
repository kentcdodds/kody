import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import {
	parseApiToken,
	redactApiTokens,
} from '@kody-internal/shared/api-token-format.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { apiTokenScopeSatisfies } from './scopes.ts'
import {
	apiTokenPolicy,
	authenticateApiToken,
	getApiTokenRecord,
	listApiTokens,
	mintApiToken,
	revokeApiToken,
	rotateApiToken,
	slideApiTokenExpiry,
	touchApiToken,
} from './service.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const userId = 'stable-user-1'
const start = new Date('2026-09-30T12:00:00.000Z')

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
		scopes: ['packages:read', 'secrets:write', 'packages:read'],
		createdVia: 'api',
		allowLocalExecute: false,
		now: start,
	})

	expect(minted).toMatchObject({
		name: 'cli',
		scopes: ['packages:read', 'secrets:write'],
		status: 'active',
		token_type: 'Bearer',
		idle_ttl_seconds: apiTokenPolicy.defaultIdleTtlSeconds,
		expires_at: at(apiTokenPolicy.defaultIdleTtlSeconds).toISOString(),
		max_expires_at: at(apiTokenPolicy.defaultMaxLifetimeSeconds).toISOString(),
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

test('authentication rejects malformed, wrong-secret, expired, and revoked tokens', async () => {
	const { db } = createDb()
	const minted = await mintApiToken({
		db,
		userId,
		name: 'short',
		scopes: ['account:read'],
		idleTtlSeconds: 60,
		createdVia: 'api',
		allowLocalExecute: false,
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
	).toMatchObject({ ok: false, reason: 'unknown', record: { id: minted.id } })
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
		scopes: ['runs:read'],
		idleTtlSeconds: 300,
		maxLifetimeSeconds: 600,
		createdVia: 'api',
		allowLocalExecute: false,
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
		scopes: ['runs:read'],
		idleTtlSeconds: apiTokenPolicy.minIdleTtlSeconds,
		createdVia: 'api',
		allowLocalExecute: false,
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
		scopes: ['jobs:write'],
		createdVia: 'mcp-api',
		allowLocalExecute: false,
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
		scopes: ['jobs:write'],
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

test('mint validates scopes, ttl bounds, local-execute access, and parent limits', async () => {
	const { db } = createDb()
	const base = {
		db,
		userId,
		name: 'bad',
		createdVia: 'api' as const,
		allowLocalExecute: false,
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
			mintApiToken({ ...base, scopes: ['runs:read'], idleTtlSeconds: 5 }),
		),
	).toBeInstanceOf(McpCallerError)
	expect(
		await rejection(mintApiToken({ ...base, scopes: ['local-execute'] })),
	).toBeInstanceOf(McpCallerError)

	const localExecute = await mintApiToken({
		...base,
		scopes: ['local-execute'],
		allowLocalExecute: true,
	})
	expect(localExecute.scopes).toEqual(['local-execute'])

	const parent = {
		scopes: ['packages:write', 'tokens:write'] as const,
		maxExpiresAt: at(3600).toISOString(),
	}
	expect(
		await rejection(
			mintApiToken({ ...base, scopes: ['secrets:read'], parent }),
		),
	).toBeInstanceOf(McpCallerError)
	const child = await mintApiToken({
		...base,
		scopes: ['packages:read'],
		parent,
	})
	expect(child.max_expires_at).toBe(at(3600).toISOString())
})

test('mint caps active tokens per account and prunes long-dead rows', async () => {
	const { sqlite, db } = createDb()
	const base = {
		db,
		userId,
		name: 'bulk',
		scopes: ['account:read'],
		createdVia: 'api' as const,
		allowLocalExecute: false,
	}
	for (let index = 0; index < apiTokenPolicy.maxActiveTokensPerUser; index++) {
		await mintApiToken({ ...base, now: start })
	}
	expect(await rejection(mintApiToken({ ...base, now: at(1) }))).toBeInstanceOf(
		McpCallerError,
	)

	const later = at(apiTokenPolicy.inactiveRetentionSeconds + 2 * 86_400)
	await mintApiToken({ ...base, now: later })
	const remaining = sqlite
		.prepare(`SELECT COUNT(*) AS count FROM api_tokens WHERE user_id = ?`)
		.get(userId) as { count: number }
	expect(remaining.count).toBe(1)
})

test('write scopes satisfy the matching read scope only', () => {
	expect(apiTokenScopeSatisfies(['packages:write'], 'packages:read')).toBe(true)
	expect(apiTokenScopeSatisfies(['packages:read'], 'packages:write')).toBe(
		false,
	)
	expect(apiTokenScopeSatisfies(['secrets:write'], 'packages:read')).toBe(false)
	expect(apiTokenScopeSatisfies(['local-execute'], 'local-execute')).toBe(true)
})
