import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	decryptWebhookUrlSecret,
	userWebhookUrlSecretContext,
} from '#mcp/secrets/crypto.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { hashWebhookUrlSecret } from './crypto.ts'
import { parseWebhookUrlHandle } from './handle.ts'
import {
	listWebhooksForUser,
	mintWebhookUrlForUser,
	revealWebhookUrlForWebsite,
	rotateWebhookUrlForUser,
	setWebhookEnabledForUser,
} from './service.ts'

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: vi.fn(async (input: { packageIdOrKodyId: string }) => {
		if (
			input.packageIdOrKodyId === 'pkg-1' ||
			input.packageIdOrKodyId === 'sentry-bridge'
		) {
			return {
				id: 'pkg-1',
				kodyId: 'sentry-bridge',
				name: '@owner/sentry-bridge',
				userId: 'ignored',
				sourceId: 'src-1',
			}
		}
		return null
	}),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: vi.fn(async () => [
		{
			id: 'pkg-1',
			userId: 'will-set',
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
	getSavedPackageByKodyId: vi.fn(),
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

function createEnv(userId: string) {
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
			enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
			created_at TEXT NOT NULL,
			rotated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX idx_webhook_endpoints_user_package_name
		ON webhook_endpoints(user_id, package_id, webhook_name);
		CREATE INDEX idx_webhook_endpoints_user_created_at
		ON webhook_endpoints(user_id, created_at);
	`)
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			username TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			stable_user_id TEXT NOT NULL
		);
	`)
	const db = createD1FromSqlite(sqlite)
	return {
		env: {
			APP_DB: db,
			APP_BASE_URL: 'https://heykody.dev',
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		} as Env,
		db,
		userId,
	}
}

test('mint/list/rotate/enable/disable webhooks are package-centered and user-scoped', async () => {
	const userId = await createStableUserIdFromEmail('owner@example.com')
	const otherUserId = await createStableUserIdFromEmail('other@example.com')
	const { env, db } = createEnv(userId)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('owner', 'owner@example.com', 'hash', ?)`,
		)
		.bind(userId)
		.run()

	const listedBefore = await listWebhooksForUser({
		env,
		baseUrl: 'https://heykody.dev',
		userId,
	})
	expect(listedBefore).toHaveLength(1)
	expect(listedBefore[0]?.minted).toBe(false)
	expect(listedBefore[0]?.verification?.secretName).toBe('sentryWebhookSecret')
	expect(listedBefore[0]?.inputMode).toBe('request')
	expect(listedBefore[0]?.rateLimitPerMinute).toBe(60)

	const minted = await mintWebhookUrlForUser({
		env,
		userId,
		email: 'owner@example.com',
		username: 'owner',
		kodyId: 'sentry-bridge',
		webhookName: 'sentry',
	})
	expect(minted.handle.startsWith('whh_')).toBe(true)
	expect(minted.urlHost).toBe('heykody.dev')
	expect(minted).not.toHaveProperty('url')
	expect(minted).not.toHaveProperty('urlSecret')
	expect(minted).not.toHaveProperty('url_secret')

	const revealed = await revealWebhookUrlForWebsite({
		env,
		userId,
		username: 'owner',
		handle: minted.handle,
	})
	expect(revealed.url).toContain('/@owner/webhooks/sentry-bridge/sentry/')
	expect(revealed.urlHost).toBe('heykody.dev')

	const listed = await listWebhooksForUser({
		env,
		baseUrl: 'https://heykody.dev',
		userId,
	})
	expect(listed[0]?.minted).toBe(true)
	expect(listed[0]?.enabled).toBe(true)
	expect(listed[0]?.handle).toBe(minted.handle)
	expect(listed[0]?.urlHost).toBe('heykody.dev')
	expect(listed[0]).not.toHaveProperty('url')
	expect(JSON.stringify(listed)).not.toContain(revealed.url)
	expect(JSON.stringify(listed)).not.toContain(
		revealed.url.slice(revealed.url.lastIndexOf('/') + 1),
	)

	const otherList = await listWebhooksForUser({
		env,
		baseUrl: 'https://heykody.dev',
		userId: otherUserId,
	})
	// Mock returns the same packages for any userId — still no mint rows for other.
	expect(otherList[0]?.minted).toBe(false)

	const rotated = await rotateWebhookUrlForUser({
		env,
		userId,
		username: 'owner',
		kodyId: 'sentry-bridge',
		webhookName: 'sentry',
	})
	expect(rotated.handle).toBe(minted.handle)
	expect(rotated).not.toHaveProperty('url')
	const stored = await db
		.prepare(
			`SELECT id, url_secret_hash, url_secret_encrypted FROM webhook_endpoints
			WHERE user_id = ? AND package_id = 'pkg-1' AND webhook_name = 'sentry'`,
		)
		.bind(userId)
		.first<{
			id: string
			url_secret_hash: string
			url_secret_encrypted: string
		}>()
	expect(stored?.id).toBe(parseWebhookUrlHandle(rotated.handle))
	expect(stored?.url_secret_encrypted).toBeTruthy()
	const rotatedSecret = await decryptWebhookUrlSecret(
		env,
		stored!.url_secret_encrypted,
		userWebhookUrlSecretContext(userId, stored!.id),
	)
	expect(stored?.url_secret_hash).toBe(
		await hashWebhookUrlSecret(rotatedSecret),
	)
	expect(rotatedSecret).not.toBe(
		revealed.url.slice(revealed.url.lastIndexOf('/') + 1),
	)

	const disabled = await setWebhookEnabledForUser({
		env,
		userId,
		kodyId: 'sentry-bridge',
		webhookName: 'sentry',
		enabled: false,
	})
	expect(disabled.enabled).toBe(false)

	const rotatedWhileDisabled = await rotateWebhookUrlForUser({
		env,
		userId,
		username: 'owner',
		kodyId: 'sentry-bridge',
		webhookName: 'sentry',
	})
	expect(rotatedWhileDisabled.enabled).toBe(false)

	const reminted = await mintWebhookUrlForUser({
		env,
		userId,
		username: 'owner',
		kodyId: 'sentry-bridge',
		webhookName: 'sentry',
	})
	expect(reminted.enabled).toBe(true)
	expect(reminted.handle).toBe(rotatedWhileDisabled.handle)
	expect(reminted).not.toHaveProperty('urlSecret')
})
