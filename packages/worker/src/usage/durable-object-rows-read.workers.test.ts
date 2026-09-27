import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test, vi } from 'vitest'
import { listRunRecords } from '#worker/run-records/service.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
import { ensureUsageRollupsTestSchema } from './test-schema.ts'

function testUserId() {
	return crypto.randomUUID().replaceAll('-', '').padEnd(64, '0')
}

async function readRollup(userId: string, metric: string) {
	const row = await env.APP_DB.prepare(
		`SELECT event_count FROM usage_rollups WHERE user_id = ? AND metric = ?`,
	)
		.bind(userId, metric)
		.first<{ event_count: number }>()
	return row?.event_count ?? 0
}

test('StorageRunner key-value and SQL reads both land on the customer rows-read meter', async () => {
	await ensureUsageRollupsTestSchema(env.APP_DB)
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	const userId = testUserId()
	const runner = storageRunnerRpc({
		env,
		userId,
		storageId: `rows-read-${crypto.randomUUID()}`,
	})
	await runner.setValue({ key: 'a', value: 1 })
	await runner.setValue({ key: 'b', value: 2 })
	await runner.setValue({ key: 'c', value: 3 })

	// One billed row per key read.
	await runner.getValue({ key: 'a' })
	await runner.getValue({ key: 'missing' })
	await vi.waitFor(async () => {
		expect(await readRollup(userId, 'durable_object_rows_read')).toBe(2)
	})

	// Two of three entries plus the look-ahead entry that detected truncation.
	const page = await runner.listValues({ pageSize: 2 })
	expect(page.truncated).toBe(true)
	await vi.waitFor(async () => {
		expect(await readRollup(userId, 'durable_object_rows_read')).toBe(5)
	})

	await runner.sqlQuery({
		query: 'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)',
		writable: true,
	})
	await runner.sqlQuery({
		query: 'INSERT INTO t (id) VALUES (1), (2), (3), (4)',
		writable: true,
	})
	const beforeSelect = await readRollup(userId, 'durable_object_rows_read')
	const selected = await runner.sqlQuery({ query: 'SELECT id FROM t' })
	expect(selected.rowsRead).toBeGreaterThanOrEqual(4)
	await vi.waitFor(async () => {
		expect(await readRollup(userId, 'durable_object_rows_read')).toBe(
			beforeSelect + selected.rowsRead,
		)
	})
	expect(await readRollup(userId, 'durable_object_platform_rows_read')).toBe(0)
})

test('RunLog knows its owning user id, which platform rows-read is keyed by', async () => {
	const userId = testUserId()
	await listRunRecords({ env, userId })
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	await runInDurableObject(stub, (_instance, state) => {
		expect(state.id.name).toBe(userId)
	})
})
