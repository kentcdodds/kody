import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	decryptWebhookUrlSecret,
	userWebhookUrlSecretContext,
} from '#mcp/secrets/crypto.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { hashWebhookUrlSecret } from './crypto.ts'
import { WebhookEndpointIdRaceError } from './errors.ts'
import { parseWebhookUrlHandle } from './handle.ts'
import * as webhookRepo from './repo.ts'
import {
	listWebhooksForUser,
	mintWebhookUrlForUser,
	revealWebhookUrlForWebsite,
	rotateWebhookUrlForUser,
	setWebhookEnabledForUser,
} from './service.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

vi.mock('#mcp/secrets/service.ts', () => ({
	resolveSecret: vi.fn(async () => ({
		found: true,
		value: 'legacy-sentry-webhook-secret',
		allowedHosts: [],
		scope: 'user',
	})),
}))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: vi.fn(
		async (input: { userId: string; packageIdOrKodyId: string }) => {
			if (
				input.packageIdOrKodyId === 'pkg-1' ||
				input.packageIdOrKodyId === 'sentry-bridge'
			) {
				return {
					id: 'pkg-1',
					kodyId: 'sentry-bridge',
					name: '@owner/sentry-bridge',
					userId: input.userId,
					sourceId: 'src-1',
				}
			}
			return null
		},
	),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: vi.fn(async () => [
		{
			id: 'pkg-1',
			userId: ownerIdFromStored('will-set'),
			name: '@owner/sentry-bridge',
			kodyId: 'sentry-bridge',
			description: 'Sentry bridge',
			tags: [],
			searchText: null,
			sourceId: 'src-1',
			hasApp: false,
			hidden: false,
			isPrivate: true,
			createdAt: '2026-07-24T00:00:00.000Z',
			updatedAt: '2026-07-24T00:00:00.000Z',
		},
	]),
	resolveSavedPackageRef: vi.fn(),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: vi.fn(async () => ({
		manifest: {
			name: '@owner/sentry-bridge',
			exports: {
				'./handle-sentry-webhook': './src/handle-sentry-webhook.ts',
			},
			kody: {
				id: 'sentry-bridge',
				description: 'Sentry bridge',
				webhooks: [
					{
						name: 'sentry',
						export: './handle-sentry-webhook',
						responseMode: 'ack',
						verification: {
							type: 'hmac-sha256',
							header: 'sentry-hook-signature',
							secretName: 'sentryWebhookSecret',
							encoding: 'hex',
						},
					},
				],
			},
		},
	})),
}))

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	// Mirrors the webhook_endpoints schema in
	// packages/worker/migrations/0001-squashed-init.sql.
	sqlite.exec(`
		CREATE TABLE webhook_endpoints (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			webhook_name TEXT NOT NULL,
			url_secret_hash TEXT NOT NULL,
			url_secret_encrypted TEXT,
			hmac_secret_encrypted TEXT,
			previous_url_secret_hash TEXT,
			previous_url_secret_expires_at TEXT,
			enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
			deleted_at TEXT,

			created_at TEXT NOT NULL,
			rotated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX idx_webhook_endpoints_user_package_name
		ON webhook_endpoints(user_id, package_id, webhook_name);
		CREATE INDEX idx_webhook_endpoints_user_created_at
		ON webhook_endpoints(user_id, created_at);
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			username TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			stable_user_id TEXT NOT NULL,
			deleted_at TEXT
		);
	`)
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'https://heykody.dev',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	return { env, db }
}

const sentryHook = { kodyId: 'sentry-bridge', webhookName: 'sentry' }

async function setupOwner(email: string, username: string) {
	const userId = testStableUserIdFromEmail(email)
	const { env, db } = createEnv()
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES (?, ?, 'hash', ?)`,
		)
		.bind(username, email, userId)
		.run()
	const input = {
		env,
		request: sessionRequestContext(userId),
		userId: ownerIdFromStored(userId),
		username,
		...sentryHook,
	}
	return {
		env,
		db,
		userId,
		mint: () => mintWebhookUrlForUser(input),
		rotate: () => rotateWebhookUrlForUser(input),
		list: (forUserId = userId) =>
			listWebhooksForUser({
				env,
				baseUrl: 'https://heykody.dev',
				userId: ownerIdFromStored(forUserId),
			}),
		readEndpoint: <T>(endpointId: string, columns: string) =>
			db
				.prepare(`SELECT ${columns} FROM webhook_endpoints WHERE id = ?`)
				.bind(endpointId)
				.first<T>(),
	}
}

const urlSecretOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)

test('mint/list/rotate/enable/disable webhooks are package-centered and user-scoped', async () => {
	const owner = await setupOwner('owner@example.com', 'owner')
	const { env, userId } = owner
	const otherUserId = testStableUserIdFromEmail('other@example.com')

	const listedBefore = await owner.list()
	expect(listedBefore).toHaveLength(1)
	expect(listedBefore[0]).toMatchObject({
		minted: false,
		urlRecoverable: false,
		verification: { secretName: 'sentryWebhookSecret' },
		inputMode: 'request',
		rateLimitPerMinute: 60,
	})

	const minted = await mintWebhookUrlForUser({
		env,
		request: sessionRequestContext(userId),
		userId: ownerIdFromStored(userId),
		email: 'owner@example.com',
		username: 'owner',
		...sentryHook,
	})
	expect(minted.handle.startsWith('whh_')).toBe(true)
	expect(minted.urlHost).toBe('heykody.dev')
	for (const secretKey of ['url', 'urlSecret', 'url_secret']) {
		expect(minted).not.toHaveProperty(secretKey)
	}

	const mintedEndpointId = parseWebhookUrlHandle(minted.handle)!
	const mintedHmac = await owner.readEndpoint<{
		hmac_secret_encrypted: string | null
	}>(mintedEndpointId, 'hmac_secret_encrypted')
	expect(mintedHmac?.hmac_secret_encrypted).toBeTruthy()

	const reveal = (
		target: Parameters<typeof revealWebhookUrlForWebsite>[0]['target'],
	) =>
		revealWebhookUrlForWebsite({
			env,
			userId: ownerIdFromStored(userId),
			username: 'owner',
			target,
		})
	const revealed = await reveal({ handle: minted.handle })
	expect(revealed.url).toContain('/@owner/webhooks/sentry-bridge/sentry/')
	expect(revealed.urlHost).toBe('heykody.dev')
	// The account UI addresses a webhook by package + name rather than by
	// handle; both paths resolve the same minted URL.
	expect(await reveal(sentryHook)).toMatchObject({
		url: revealed.url,
		handle: minted.handle,
	})

	const listed = await owner.list()
	expect(listed[0]).toMatchObject({
		minted: true,
		enabled: true,
		handle: minted.handle,
		urlHost: 'heykody.dev',
		urlRecoverable: true,
	})
	expect(listed[0]).not.toHaveProperty('url')
	expect(JSON.stringify(listed)).not.toContain(revealed.url)
	expect(JSON.stringify(listed)).not.toContain(urlSecretOf(revealed.url))

	// Mock returns the same packages for any userId — still no mint rows for other.
	expect((await owner.list(otherUserId))[0]?.minted).toBe(false)

	const rotated = await owner.rotate()
	expect(rotated.handle).toBe(minted.handle)
	expect(rotated).not.toHaveProperty('url')
	const stored = await owner.db
		.prepare(
			`SELECT id, url_secret_hash, url_secret_encrypted,
				previous_url_secret_hash, previous_url_secret_expires_at
			FROM webhook_endpoints
			WHERE user_id = ? AND package_id = 'pkg-1' AND webhook_name = 'sentry'`,
		)
		.bind(userId)
		.first<{
			id: string
			url_secret_hash: string
			url_secret_encrypted: string
			previous_url_secret_hash: string
			previous_url_secret_expires_at: string
		}>()
	const endpointId = parseWebhookUrlHandle(rotated.handle)!
	expect(stored?.id).toBe(endpointId)
	expect(stored?.url_secret_encrypted).toBeTruthy()
	const rotatedSecret = await decryptWebhookUrlSecret(
		env,
		stored!.url_secret_encrypted,
		userWebhookUrlSecretContext(ownerIdFromStored(userId), endpointId),
	)
	const previousSecret = urlSecretOf(revealed.url)
	expect(rotatedSecret).not.toBe(previousSecret)
	expect(stored).toMatchObject({
		url_secret_hash: await hashWebhookUrlSecret(rotatedSecret),
		previous_url_secret_hash: await hashWebhookUrlSecret(previousSecret),
		previous_url_secret_expires_at: expect.any(String),
	})
	expect((await owner.list())[0]?.previousUrlActiveUntil).toBe(
		stored?.previous_url_secret_expires_at,
	)
	const overlapUntil = Date.parse(stored!.previous_url_secret_expires_at)
	const overlapExpected = Date.now() + 24 * 60 * 60 * 1000
	expect(overlapUntil).toBeGreaterThan(overlapExpected - 10_000)
	expect(overlapUntil).toBeLessThan(overlapExpected + 10_000)

	const disabled = await setWebhookEnabledForUser({
		env,
		request: sessionRequestContext(userId),
		userId: ownerIdFromStored(userId),
		...sentryHook,
		enabled: false,
	})
	expect(disabled.enabled).toBe(false)
	const rotatedWhileDisabled = await owner.rotate()
	expect(rotatedWhileDisabled.enabled).toBe(false)

	const reminted = await owner.mint()
	expect(reminted.enabled).toBe(true)
	expect(reminted.handle).toBe(rotatedWhileDisabled.handle)
	expect(reminted).not.toHaveProperty('urlSecret')
})

test('clearing rotate overlap ignores a stale current-hash snapshot', async () => {
	const owner = await setupOwner('overlap-race@example.com', 'racer')
	const { db, userId } = owner
	type Hashes = {
		url_secret_hash: string
		previous_url_secret_hash: string | null
		previous_url_secret_expires_at: string | null
	}
	const endpointId = parseWebhookUrlHandle((await owner.mint()).handle)!
	const readHashes = () =>
		owner.readEndpoint<Hashes>(
			endpointId,
			'url_secret_hash, previous_url_secret_hash, previous_url_secret_expires_at',
		)
	const clearFor = (urlSecretHash: string) =>
		webhookRepo.clearWebhookEndpointPreviousUrlSecret({
			db,
			userId,
			endpointId,
			urlSecretHash,
		})

	await owner.rotate()
	const afterFirstRotate = (await readHashes())!
	expect(afterFirstRotate.previous_url_secret_hash).toBeTruthy()

	await owner.rotate()
	const afterSecondRotate = (await readHashes())!
	expect(afterSecondRotate.url_secret_hash).not.toBe(
		afterFirstRotate.url_secret_hash,
	)
	expect(afterSecondRotate.previous_url_secret_hash).toBe(
		afterFirstRotate.url_secret_hash,
	)

	await clearFor(afterFirstRotate.url_secret_hash)
	expect(await readHashes()).toEqual(afterSecondRotate)

	await clearFor(afterSecondRotate.url_secret_hash)
	expect(await readHashes()).toMatchObject({
		previous_url_secret_hash: null,
		previous_url_secret_expires_at: null,
	})
})

test('first mint that loses the id race retries with the persisted endpoint id', async () => {
	const userId = testStableUserIdFromEmail('race@example.com')
	const { env, db } = createEnv()
	const winnerId = '11111111-1111-1111-1111-111111111111'
	await db
		.prepare(
			`INSERT INTO webhook_endpoints (
				id, user_id, package_id, webhook_name, url_secret_hash,
				url_secret_encrypted, enabled, created_at, rotated_at
			) VALUES (?, ?, 'pkg-1', 'sentry', 'stale-hash', 'stale-ciphertext', 1, ?, ?)`,
		)
		.bind(
			winnerId,
			userId,
			'2026-09-01T00:00:00.000Z',
			'2026-09-01T00:00:00.000Z',
		)
		.run()

	const raceError = await webhookRepo
		.upsertWebhookEndpointSecret({
			db,
			id: '22222222-2222-2222-2222-222222222222',
			userId,
			packageId: 'pkg-1',
			webhookName: 'sentry',
			urlSecretHash: 'unused-hash',
			urlSecretEncrypted: 'unused-ciphertext',
		})
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(raceError).toBeInstanceOf(WebhookEndpointIdRaceError)
	expect((raceError as WebhookEndpointIdRaceError).existingId).toBe(winnerId)

	const getByKey = vi.spyOn(webhookRepo, 'getWebhookEndpointByKey')
	const upsert = vi.spyOn(webhookRepo, 'upsertWebhookEndpointSecret')
	getByKey.mockImplementationOnce(async () => null)

	const minted = await mintWebhookUrlForUser({
		env,
		request: sessionRequestContext(userId),
		userId: ownerIdFromStored(userId),
		email: 'race@example.com',
		username: 'racer',
		...sentryHook,
	})

	expect(upsert).toHaveBeenCalledTimes(2)
	expect(parseWebhookUrlHandle(minted.handle)).toBe(winnerId)
	expect(minted.handle).toBe(`whh_${winnerId}`)

	const stored = await db
		.prepare(
			`SELECT url_secret_hash, url_secret_encrypted FROM webhook_endpoints
			WHERE user_id = ? AND id = ?`,
		)
		.bind(userId, winnerId)
		.first<{ url_secret_hash: string; url_secret_encrypted: string }>()
	expect(stored?.url_secret_encrypted).toBeTruthy()
	expect(stored?.url_secret_encrypted).not.toBe('stale-ciphertext')
	const mintedSecret = await decryptWebhookUrlSecret(
		env,
		stored!.url_secret_encrypted,
		userWebhookUrlSecretContext(ownerIdFromStored(userId), winnerId),
	)
	expect(stored?.url_secret_hash).toBe(await hashWebhookUrlSecret(mintedSecret))

	getByKey.mockRestore()
	upsert.mockRestore()
})

test('concurrent first mints converge on one handle', async () => {
	const userId = testStableUserIdFromEmail('parallel@example.com')
	const { env } = createEnv()
	const mint = () =>
		mintWebhookUrlForUser({
			env,
			request: sessionRequestContext(userId),
			userId: ownerIdFromStored(userId),
			username: 'parallel',
			...sentryHook,
		})
	const [first, second] = await Promise.all([mint(), mint()])
	expect(first.handle).toBe(second.handle)
	expect(first.urlHost).toBe('heykody.dev')
	expect(second).not.toHaveProperty('url')
})

test('listing webhooks loads package manifests concurrently', async () => {
	const userId = testStableUserIdFromEmail('many@example.com')
	const { env } = createEnv()
	const kodyIdFor = (index: number) => `many-${String(index).padStart(2, '0')}`
	const packages = Array.from({ length: 20 }, (_, index) => ({
		id: `pkg-many-${index}`,
		userId: ownerIdFromStored(userId),
		name: `@owner/many-${index}`,
		kodyId: kodyIdFor(index),
		description: 'Many',
		tags: [],
		searchText: null,
		sourceId: `src-many-${index}`,
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: true,
		lockedAt: null,
		createdAt: '2026-07-24T00:00:00.000Z',
		updatedAt: '2026-07-24T00:00:00.000Z',
	}))
	vi.mocked(listSavedPackagesByUserId).mockResolvedValueOnce(packages)
	let inFlight = 0
	let maxInFlight = 0
	vi.mocked(loadPackageManifestBySourceId).mockImplementation((async (input: {
		sourceId: string
	}) => {
		inFlight += 1
		maxInFlight = Math.max(maxInFlight, inFlight)
		await new Promise((resolve) => setTimeout(resolve, 5))
		inFlight -= 1
		if (input.sourceId === 'src-many-3') throw new Error('manifest blip')
		const index = Number(input.sourceId.replace('src-many-', ''))
		return {
			manifest: {
				name: `@owner/many-${index}`,
				exports: { './hook': './src/hook.ts' },
				kody: {
					id: kodyIdFor(index),
					description: 'Many',
					webhooks: [{ name: 'hook', export: './hook', responseMode: 'ack' }],
				},
			},
		}
	}) as never)
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

	const listed = await listWebhooksForUser({
		env,
		baseUrl: 'https://heykody.dev',
		userId: ownerIdFromStored(userId),
	})

	warn.mockRestore()
	expect(maxInFlight).toBe(packages.length)
	expect(listed.map((webhook) => webhook.packageKodyId)).toEqual(
		packages
			.map((entry) => entry.kodyId)
			.filter((kodyId) => kodyId !== 'many-03'),
	)
})
