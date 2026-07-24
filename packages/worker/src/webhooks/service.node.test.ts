import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { hashWebhookUrlSecret } from './crypto.ts'
import {
	listWebhookDeliveriesForUser,
	listWebhooksForUser,
	mintWebhookUrlForUser,
	rotateWebhookUrlForUser,
	setWebhookEnabledForUser,
} from './service.ts'
import { insertWebhookDelivery } from './repo.ts'

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
	sqlite.exec(
		readFileSync(
			path.join(
				process.cwd(),
				'packages/worker/migrations/0090-webhook-endpoints.sql',
			),
			'utf8',
		),
	)
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

	const minted = await mintWebhookUrlForUser({
		env,
		userId,
		email: 'owner@example.com',
		username: 'owner',
		kodyId: 'sentry-bridge',
		webhookName: 'sentry',
	})
	expect(minted.url).toContain('/@owner/webhooks/sentry-bridge/sentry/')
	expect(minted.urlSecret.length).toBeGreaterThan(10)

	const listed = await listWebhooksForUser({
		env,
		baseUrl: 'https://heykody.dev',
		userId,
	})
	expect(listed[0]?.minted).toBe(true)
	expect(listed[0]?.enabled).toBe(true)
	expect(listed[0]).not.toHaveProperty('url')
	expect(JSON.stringify(listed)).not.toContain(minted.urlSecret)

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
	expect(rotated.urlSecret).not.toBe(minted.urlSecret)
	const stored = await db
		.prepare(
			`SELECT url_secret_hash FROM webhook_endpoints
			WHERE user_id = ? AND package_id = 'pkg-1' AND webhook_name = 'sentry'`,
		)
		.bind(userId)
		.first<{ url_secret_hash: string }>()
	expect(stored?.url_secret_hash).toBe(
		await hashWebhookUrlSecret(rotated.urlSecret),
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
	expect(reminted.urlSecret).not.toBe(rotatedWhileDisabled.urlSecret)

	const endpoint = await db
		.prepare(`SELECT id FROM webhook_endpoints WHERE user_id = ?`)
		.bind(userId)
		.first<{ id: string }>()
	await insertWebhookDelivery({
		db,
		id: 'del-1',
		endpointId: endpoint!.id,
		userId,
		packageId: 'pkg-1',
		webhookName: 'sentry',
		receivedAt: '2026-07-24T01:00:00.000Z',
		outcome: 'delivered',
		httpStatus: 202,
		payloadBytes: 10,
	})
	const deliveries = await listWebhookDeliveriesForUser({
		env,
		userId,
		kodyId: 'sentry-bridge',
		webhookName: 'sentry',
	})
	expect(deliveries).toHaveLength(1)
})
