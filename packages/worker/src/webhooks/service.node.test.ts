import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	createWebhookEndpointForUser,
	deleteWebhookEndpointForUser,
	getWebhookEndpointForUser,
	listWebhookDeliveriesForUser,
	listWebhookEndpointsForUserService,
	rotateWebhookEndpointSecretForUser,
	updateWebhookEndpointForUser,
} from './service.ts'
import { hashWebhookUrlSecret } from './crypto.ts'
import { insertWebhookDelivery } from './repo.ts'

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: vi.fn(async (input: { packageIdOrKodyId: string }) => {
		if (
			input.packageIdOrKodyId === 'pkg-1' ||
			input.packageIdOrKodyId === 'demo-kody'
		) {
			return {
				id: 'pkg-1',
				kodyId: 'demo-kody',
				name: 'Demo',
				userId: 'will-be-ignored',
			}
		}
		return null
	}),
}))

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	const migration = readFileSync(
		path.join(
			process.cwd(),
			'packages/worker/migrations/0090-webhook-endpoints.sql',
		),
		'utf8',
	)
	sqlite.exec(migration)
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
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'https://heykody.dev',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Env
	return { env, db, sqlite }
}

test('webhook endpoint CRUD scopes by userId, returns secret once, and lists deliveries', async () => {
	const { env, db } = createEnv()
	const userId = await createStableUserIdFromEmail('owner@example.com')
	const otherUserId = await createStableUserIdFromEmail('other@example.com')
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('owner', 'owner@example.com', 'hash', ?)`,
		)
		.bind(userId)
		.run()
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('other', 'other@example.com', 'hash', ?)`,
		)
		.bind(otherUserId)
		.run()

	const created = await createWebhookEndpointForUser({
		env,
		userId,
		email: 'owner@example.com',
		username: 'owner',
		name: 'sentry-errors',
		kodyId: 'demo-kody',
		exportName: 'handle-webhook',
		responseMode: 'ack',
		verification: {
			type: 'hmac-sha256',
			header: 'sentry-hook-signature',
			secret: 'sentry-client-secret',
			encoding: 'hex',
		},
	})

	expect(created.url).toContain('/@owner/webhooks/')
	expect(created.urlSecret.length).toBeGreaterThan(10)
	expect(created.verification).toEqual({
		type: 'hmac-sha256',
		header: 'sentry-hook-signature',
		encoding: 'hex',
	})
	expect(JSON.stringify(created.verification)).not.toContain(
		'sentry-client-secret',
	)

	const listed = await listWebhookEndpointsForUserService({ db, userId })
	expect(listed).toHaveLength(1)
	expect(listed[0]).not.toHaveProperty('url')
	expect(listed[0]).not.toHaveProperty('urlSecret')
	expect(listed[0]?.verification).toEqual({
		type: 'hmac-sha256',
		header: 'sentry-hook-signature',
		encoding: 'hex',
	})

	const otherList = await listWebhookEndpointsForUserService({
		db,
		userId: otherUserId,
	})
	expect(otherList).toHaveLength(0)

	const got = await getWebhookEndpointForUser({
		db,
		userId,
		endpointId: created.id,
	})
	expect(got?.packageId).toBe('pkg-1')
	expect(got?.exportName).toBe('./handle-webhook')

	const crossGet = await getWebhookEndpointForUser({
		db,
		userId: otherUserId,
		endpointId: created.id,
	})
	expect(crossGet).toBeNull()

	const updated = await updateWebhookEndpointForUser({
		env,
		userId,
		endpointId: created.id,
		enabled: false,
		name: 'sentry-prod',
		clearVerification: true,
	})
	expect(updated?.enabled).toBe(false)
	expect(updated?.name).toBe('sentry-prod')
	expect(updated?.verification).toBeNull()

	const rotated = await rotateWebhookEndpointSecretForUser({
		env,
		userId,
		email: 'owner@example.com',
		username: 'owner',
		endpointId: created.id,
	})
	expect(rotated?.urlSecret).not.toBe(created.urlSecret)
	expect(rotated?.url).toContain(rotated?.urlSecret ?? '')

	const storedHash = await db
		.prepare(`SELECT url_secret_hash FROM webhook_endpoints WHERE id = ?`)
		.bind(created.id)
		.first<{ url_secret_hash: string }>()
	expect(storedHash?.url_secret_hash).toBe(
		await hashWebhookUrlSecret(rotated!.urlSecret),
	)
	expect(storedHash?.url_secret_hash).not.toBe(rotated!.urlSecret)

	await insertWebhookDelivery({
		db,
		id: 'del-1',
		endpointId: created.id,
		userId,
		receivedAt: '2026-07-24T01:00:00.000Z',
		outcome: 'delivered',
		httpStatus: 202,
		payloadBytes: 12,
	})
	const deliveries = await listWebhookDeliveriesForUser({
		db,
		userId,
		endpointId: created.id,
	})
	expect(deliveries).toHaveLength(1)
	expect(deliveries[0]?.outcome).toBe('delivered')

	await expect(
		listWebhookDeliveriesForUser({
			db,
			userId: otherUserId,
			endpointId: created.id,
		}),
	).rejects.toThrow(/not found/i)

	const deleted = await deleteWebhookEndpointForUser({
		db,
		userId,
		endpointId: created.id,
	})
	expect(deleted).toBe(true)
	expect(
		await getWebhookEndpointForUser({
			db,
			userId,
			endpointId: created.id,
		}),
	).toBeNull()
})
