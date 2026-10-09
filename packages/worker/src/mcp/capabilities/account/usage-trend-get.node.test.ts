import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { userMeterDailyCounterRetentionDays } from '#worker/entitlements/user-meter-do.ts'
import {
	readAccountUsageTrend,
	usageTrendMonthHistoryMonths,
} from '#worker/entitlements/usage-trend.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { usageTrendGetCapability } from './usage-trend-get.ts'

const email = 'usage-trend-get@example.com'

function createTrendEnv() {
	const stableUserId = testStableUserIdFromEmail(email)
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	applyAllMigrations(
		sqlite,
		new URL('../../../../../jobs-worker/migrations/', import.meta.url),
	)
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, plan)
			 VALUES ('usage-trend', ?, 'hash', ?, 'pro')`,
		)
		.run(email, stableUserId)
	const db = createD1FromSqlite(sqlite)
	const userMeter = createInMemoryUserMeterEnv()
	return {
		stableUserId,
		sqlite,
		env: {
			APP_DB: db,
			...userMeter.env,
			...createInMemoryRunLogUsageEnv().env,
			REPO_SESSION_INDEX:
				createInMemoryRepoSessionIndexEnv(db).REPO_SESSION_INDEX,
		} as unknown as Env,
		userMeter,
	}
}

function callerContext(userId: string) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored(userId),
			email,
			displayName: 'Usage Trend',
		},
	})
}

function shiftUtcDays(base: Date, deltaDays: number) {
	const next = new Date(base)
	next.setUTCDate(next.getUTCDate() + deltaDays)
	return next
}

function meterStub(env: Env, userId: string) {
	return env.USER_METER.get(env.USER_METER.idFromName(userId)) as {
		claimDynamicWorkerDay: (input: {
			workerId: string
			day: string
			createdAt: string
		}) => Promise<{ created: boolean }>
	}
}

test('usageTrendGet requires a signed-in user', async () => {
	const { env } = createTrendEnv()
	await expect(
		usageTrendGetCapability.handler(
			{},
			{
				env,
				callerContext: createMcpCallerContext({
					source: { kind: 'mcp-oauth' },
					baseUrl: 'https://example.com',
				}),
			},
		),
	).rejects.toThrow(/Authenticated MCP user/)
})

test('usageTrendGet returns a zero-filled retention window when empty', async () => {
	const { env, stableUserId } = createTrendEnv()
	const result = await usageTrendGetCapability.handler(
		{},
		{
			env,
			callerContext: callerContext(stableUserId),
		},
	)

	expect(result.retentionDays).toBe(userMeterDailyCounterRetentionDays)
	expect(result.days).toHaveLength(userMeterDailyCounterRetentionDays)
	expect(result.days.every((day) => day.execute === 0)).toBe(true)
	expect(result.days.every((day) => day.uniqueWorkerDays === 0)).toBe(true)
	expect(result.days.every((day) => day.jobRuns === undefined)).toBe(true)
	expect(
		result.days.every((day) => day.automationInvocations === undefined),
	).toBe(true)
	expect(result.months).toHaveLength(usageTrendMonthHistoryMonths)
	expect(result.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/)
	expect(result.days[0]!.day < result.days.at(-1)!.day).toBe(true)
})

test('usageTrendGet maps partial days and monthly rollups for the signed-in user', async () => {
	const now = new Date('2026-10-07T15:30:00.000Z')
	const today = utcDayKey(now)
	const yesterday = utcDayKey(shiftUtcDays(now, -1))
	const twoDaysAgo = utcDayKey(shiftUtcDays(now, -2))
	const { env, stableUserId, sqlite, userMeter } = createTrendEnv()

	await userMeter.seed({
		userId: stableUserId,
		resource: 'execute_calls_per_day',
		day: twoDaysAgo,
		count: 4,
	})
	await userMeter.seed({
		userId: stableUserId,
		resource: 'execute_calls_per_day',
		day: yesterday,
		count: 11,
	})
	await userMeter.seed({
		userId: stableUserId,
		resource: 'job_runs_per_day',
		day: yesterday,
		count: 2,
	})
	await userMeter.seed({
		userId: stableUserId,
		resource: 'automation_invocations_per_day',
		day: today,
		count: 3,
	})

	const meter = meterStub(env, stableUserId)
	await meter.claimDynamicWorkerDay({
		workerId: 'worker-a',
		day: yesterday,
		createdAt: now.toISOString(),
	})
	await meter.claimDynamicWorkerDay({
		workerId: 'worker-b',
		day: yesterday,
		createdAt: now.toISOString(),
	})
	await meter.claimDynamicWorkerDay({
		workerId: 'worker-a',
		day: today,
		createdAt: now.toISOString(),
	})

	const currentMonth = utcMonthKey(now)
	const priorMonth = utcMonthKey(
		new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
	)
	sqlite
		.prepare(
			`INSERT INTO usage_rollups (user_id, metric, month, event_count)
			 VALUES (?, 'execute', ?, 90),
			        (?, 'dynamic_worker_day', ?, 7),
			        (?, 'execute', ?, 40)`,
		)
		.run(
			stableUserId,
			currentMonth,
			stableUserId,
			currentMonth,
			stableUserId,
			priorMonth,
		)

	const trend = await readAccountUsageTrend({
		db: env.APP_DB,
		env,
		userId: stableUserId,
		now,
	})

	expect(trend.days).toHaveLength(userMeterDailyCounterRetentionDays)
	expect(trend.days.find((day) => day.day === twoDaysAgo)).toEqual({
		day: twoDaysAgo,
		execute: 4,
		uniqueWorkerDays: 0,
		jobRuns: 0,
		automationInvocations: 0,
	})
	expect(trend.days.find((day) => day.day === yesterday)).toEqual({
		day: yesterday,
		execute: 11,
		uniqueWorkerDays: 2,
		jobRuns: 2,
		automationInvocations: 0,
	})
	expect(trend.days.find((day) => day.day === today)).toEqual({
		day: today,
		execute: 0,
		uniqueWorkerDays: 1,
		jobRuns: 0,
		automationInvocations: 3,
	})
	expect(trend.months.find((row) => row.month === priorMonth)).toEqual({
		month: priorMonth,
		execute: 40,
		uniqueWorkerDays: 0,
	})
	expect(trend.months.find((row) => row.month === currentMonth)).toEqual({
		month: currentMonth,
		execute: 90,
		uniqueWorkerDays: 7,
	})
	expect(trend.months.at(-1)?.month).toBe(currentMonth)

	// Capability path (wall clock): seed relative to today and assert shape.
	const liveNow = new Date()
	const liveToday = utcDayKey(liveNow)
	const liveYesterday = utcDayKey(shiftUtcDays(liveNow, -1))
	const liveEnv = createTrendEnv()
	await liveEnv.userMeter.seed({
		userId: liveEnv.stableUserId,
		resource: 'execute_calls_per_day',
		day: liveYesterday,
		count: 5,
	})
	await liveEnv.userMeter.seed({
		userId: liveEnv.stableUserId,
		resource: 'execute_calls_per_day',
		day: liveToday,
		count: 8,
	})
	await meterStub(liveEnv.env, liveEnv.stableUserId).claimDynamicWorkerDay({
		workerId: 'live-worker',
		day: liveToday,
		createdAt: liveNow.toISOString(),
	})

	const capabilityResult = await usageTrendGetCapability.handler(
		{},
		{
			env: liveEnv.env,
			callerContext: callerContext(liveEnv.stableUserId),
		},
	)
	expect(
		capabilityResult.days.find((day) => day.day === liveYesterday),
	).toEqual({
		day: liveYesterday,
		execute: 5,
		uniqueWorkerDays: 0,
	})
	expect(capabilityResult.days.find((day) => day.day === liveToday)).toEqual({
		day: liveToday,
		execute: 8,
		uniqueWorkerDays: 1,
	})
})
