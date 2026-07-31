import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { ensureEmailTestSchema } from '#worker/email/test-schema.ts'
import {
	calculateUserD1StorageBytes,
	readUserD1StorageBytes,
} from './service.ts'
import { reconcileD1StorageBytes } from './d1-storage-reconciliation.ts'

async function insertReconciliationUser(input: {
	userId: string
	email: string
	storedBytes: number
	updatedAt: string
}) {
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, stable_user_id,
			d1_storage_bytes, d1_storage_bytes_updated_at
		) VALUES (?, ?, 'test-password', ?, ?, ?)`,
	)
		.bind(
			`d1-reconcile-${crypto.randomUUID().slice(0, 8)}`,
			input.email,
			input.userId,
			input.storedBytes,
			input.updatedAt,
		)
		.run()
}

test('D1 storage reconciliation is bounded and replaces stored drift with authoritative bytes', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes_updated_at = '9999-12-31T23:59:59.999Z'`,
	).run()

	const firstUserId = '1'.repeat(64)
	const secondUserId = '2'.repeat(64)
	await insertReconciliationUser({
		userId: firstUserId,
		email: `${crypto.randomUUID()}@example.test`,
		storedBytes: 1,
		updatedAt: '2020-01-01T00:00:00.000Z',
	})
	await insertReconciliationUser({
		userId: secondUserId,
		email: `${crypto.randomUUID()}@example.test`,
		storedBytes: 99,
		updatedAt: '2021-01-01T00:00:00.000Z',
	})
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, from_address, subject, text_body, raw_size,
			processing_status, created_at, updated_at
		) VALUES (?, 'inbound', ?, 'sender@example.test', 'subject', 'body', 128,
			'stored', ?, ?)`,
	)
		.bind(
			crypto.randomUUID(),
			firstUserId,
			'2026-07-31T00:00:00.000Z',
			'2026-07-31T00:00:00.000Z',
		)
		.run()

	const expectedFirstBytes = await calculateUserD1StorageBytes({
		db: env.APP_DB,
		userId: firstUserId,
	})
	expect(expectedFirstBytes).toBeGreaterThan(128)

	await expect(
		reconcileD1StorageBytes({
			db: env.APP_DB,
			now: new Date('2026-07-31T01:00:00.000Z'),
			batchSize: 1,
		}),
	).resolves.toEqual({ scanned: 1, updated: 1, failed: 0 })
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId: firstUserId }),
	).resolves.toBe(expectedFirstBytes)
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId: secondUserId }),
	).resolves.toBe(99)

	await expect(
		reconcileD1StorageBytes({
			db: env.APP_DB,
			now: new Date('2026-07-31T01:05:00.000Z'),
			batchSize: 1,
		}),
	).resolves.toEqual({ scanned: 1, updated: 1, failed: 0 })
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId: secondUserId }),
	).resolves.toBe(0)
})
