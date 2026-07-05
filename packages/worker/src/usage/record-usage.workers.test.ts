import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { recordUsage } from './record-usage.ts'
import { ensureUsageRollupsTestSchema } from './test-schema.ts'

async function listRollups(db: D1Database, userId: string) {
	const { results } = await db
		.prepare(
			`SELECT user_id, metric, month, event_count, error_count,
				total_duration_ms, total_cpu_ms, total_bytes
			FROM usage_rollups WHERE user_id = ?1
			ORDER BY metric, month`,
		)
		.bind(userId)
		.all()
	return results
}

test('recordUsage accumulates per-user monthly rollups and writes analytics data points', async () => {
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const userA = `usage-user-a-${crypto.randomUUID()}`
	const userB = `usage-user-b-${crypto.randomUUID()}`
	const dataPoints: Array<AnalyticsEngineDataPoint> = []
	const usageEnv = {
		APP_DB: env.APP_DB,
		USAGE_EVENTS: {
			writeDataPoint(point?: AnalyticsEngineDataPoint) {
				if (point) dataPoints.push(point)
			},
		},
	}

	await recordUsage(usageEnv, {
		userId: userA,
		eventType: 'execute',
		durationMs: 120,
		outcome: 'success',
		timestamp: '2026-07-05T10:00:00.000Z',
	})
	await recordUsage(usageEnv, {
		userId: userA,
		eventType: 'execute',
		entityId: 'pkg-1',
		durationMs: 80,
		bytes: 512,
		outcome: 'error',
		timestamp: '2026-07-05T11:00:00.000Z',
	})
	await recordUsage(usageEnv, {
		userId: userA,
		eventType: 'email_send',
		entityId: 'message-1',
		bytes: 2048,
		outcome: 'success',
		timestamp: '2026-08-01T00:00:00.000Z',
	})
	await recordUsage(usageEnv, {
		userId: userB,
		eventType: 'execute',
		durationMs: 40,
		outcome: 'success',
		timestamp: '2026-07-05T12:00:00.000Z',
	})

	expect(await listRollups(env.APP_DB, userA)).toEqual([
		{
			user_id: userA,
			metric: 'email_send',
			month: '2026-08',
			event_count: 1,
			error_count: 0,
			total_duration_ms: 0,
			total_cpu_ms: 0,
			total_bytes: 2048,
		},
		{
			user_id: userA,
			metric: 'execute',
			month: '2026-07',
			event_count: 2,
			error_count: 1,
			total_duration_ms: 200,
			total_cpu_ms: 0,
			total_bytes: 512,
		},
	])
	// Cross-user isolation: user B only ever sees their own single event.
	expect(await listRollups(env.APP_DB, userB)).toEqual([
		{
			user_id: userB,
			metric: 'execute',
			month: '2026-07',
			event_count: 1,
			error_count: 0,
			total_duration_ms: 40,
			total_cpu_ms: 0,
			total_bytes: 0,
		},
	])

	expect(dataPoints).toHaveLength(4)
	expect(dataPoints[0]).toEqual({
		indexes: [userA],
		blobs: [userA, 'execute', '', 'success', '2026-07-05T10:00:00.000Z'],
		doubles: [120, 0, 0],
	})
	expect(dataPoints[1]).toEqual({
		indexes: [userA],
		blobs: [userA, 'execute', 'pkg-1', 'error', '2026-07-05T11:00:00.000Z'],
		doubles: [80, 0, 512],
	})
	expect(dataPoints[3]?.indexes).toEqual([userB])
})

test('recordUsage never throws when bindings are missing, sinks fail, or userId is empty', async () => {
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const userId = `usage-degrade-user-${crypto.randomUUID()}`

	// No bindings at all (local dev / test without Analytics Engine).
	await expect(
		recordUsage({}, { userId, eventType: 'execute', outcome: 'success' }),
	).resolves.toBeUndefined()

	// Analytics Engine sink throws; rollup must still be written.
	await expect(
		recordUsage(
			{
				APP_DB: env.APP_DB,
				USAGE_EVENTS: {
					writeDataPoint() {
						throw new Error('analytics engine unavailable')
					},
				},
			},
			{
				userId,
				eventType: 'job_run',
				entityId: 'job-1',
				durationMs: 10,
				outcome: 'success',
				timestamp: '2026-07-05T10:00:00.000Z',
			},
		),
	).resolves.toBeUndefined()
	expect(await listRollups(env.APP_DB, userId)).toEqual([
		{
			user_id: userId,
			metric: 'job_run',
			month: '2026-07',
			event_count: 1,
			error_count: 0,
			total_duration_ms: 10,
			total_cpu_ms: 0,
			total_bytes: 0,
		},
	])

	// Missing userId: skipped entirely, no row written.
	await expect(
		recordUsage(
			{ APP_DB: env.APP_DB },
			{ userId: '', eventType: 'execute', outcome: 'success' },
		),
	).resolves.toBeUndefined()
	expect(await listRollups(env.APP_DB, '')).toEqual([])

	// Rollup table missing (pre-migration database): degrade, don't throw.
	await env.APP_DB.prepare('DROP TABLE usage_rollups').run()
	await expect(
		recordUsage(
			{ APP_DB: env.APP_DB },
			{ userId, eventType: 'execute', outcome: 'success' },
		),
	).resolves.toBeUndefined()
})
