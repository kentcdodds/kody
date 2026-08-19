import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	listPlatformStorageBuckets,
	listStorageBucketsMissingEstimates,
	listUserStorageBucketEstimates,
	listUserStorageBucketIds,
} from './service.ts'

const storageRunnerMock = vi.hoisted(() => ({
	clearStorage: vi.fn(async () => ({ ok: true as const })),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	storageRunnerRpc: () => ({
		clearStorage: (...args: Array<unknown>) =>
			storageRunnerMock.clearStorage(...args),
	}),
}))

const { purgeRetiredServiceStorageBuckets } =
	await import('./purge-retired-service-storage.ts')

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

async function insertBucket(
	db: D1Database,
	row: { userId: string; storageId: string; kind: string },
) {
	const now = '2026-08-19T00:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO user_storage_buckets (
				user_id, storage_id, kind, created_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(row.userId, row.storageId, row.kind, now, now)
		.run()
}

test('migration 0016 keeps leftover service inventory until StorageRunner clear succeeds', async () => {
	consoleWarn.mockImplementation(() => {})
	const db = createDb()
	const env = { APP_DB: db } as Env
	await insertBucket(db, {
		userId: 'user-a',
		storageId: 'service:gateway',
		kind: 'service',
	})
	await insertBucket(db, {
		userId: 'user-a',
		storageId: 'package:keep',
		kind: 'package',
	})
	await insertBucket(db, {
		userId: 'user-b',
		storageId: 'service:other',
		kind: 'service',
	})

	await expect(
		listUserStorageBucketIds({ env, userId: 'user-a' }),
	).resolves.toEqual(['package:keep', 'service:gateway'])
	await expect(listPlatformStorageBuckets({ db })).resolves.toEqual([
		{ userId: 'user-a', storageId: 'package:keep' },
		{ userId: 'user-a', storageId: 'service:gateway' },
		{ userId: 'user-b', storageId: 'service:other' },
	])
	await expect(
		listUserStorageBucketEstimates({ env, userId: 'user-a' }),
	).resolves.toEqual([
		{ storageId: 'package:keep', kind: 'package', estimatedBytes: null },
		{ storageId: 'service:gateway', kind: 'unknown', estimatedBytes: null },
	])
	await expect(
		listStorageBucketsMissingEstimates({ db, limit: 10 }),
	).resolves.toEqual([
		{ userId: 'user-a', storageId: 'package:keep', kind: 'package' },
	])

	storageRunnerMock.clearStorage.mockImplementationOnce(async () => {
		throw new Error('storage runner unavailable')
	})
	await expect(
		purgeRetiredServiceStorageBuckets({ env, limit: 1 }),
	).resolves.toEqual({ scanned: 1, purged: 0, failed: 1 })
	expect(consoleWarn).toHaveBeenCalledWith(
		'retired-service-storage-purge-row-failed',
		'service:gateway',
		expect.any(Error),
	)
	await expect(
		listUserStorageBucketIds({ env, userId: 'user-a' }),
	).resolves.toEqual(['package:keep', 'service:gateway'])

	storageRunnerMock.clearStorage.mockResolvedValue({ ok: true })
	await expect(purgeRetiredServiceStorageBuckets({ env })).resolves.toEqual({
		scanned: 2,
		purged: 2,
		failed: 0,
	})
	expect(storageRunnerMock.clearStorage).toHaveBeenCalledTimes(3)
	await expect(
		listUserStorageBucketIds({ env, userId: 'user-a' }),
	).resolves.toEqual(['package:keep'])
	await expect(listPlatformStorageBuckets({ db })).resolves.toEqual([
		{ userId: 'user-a', storageId: 'package:keep' },
	])
	await expect(
		listUserStorageBucketIds({ env, userId: 'user-b' }),
	).resolves.toEqual([])
})
