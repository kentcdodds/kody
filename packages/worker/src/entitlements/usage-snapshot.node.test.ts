import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { legacyPlanLimits, planLimits } from '#universal/plans.ts'
import { readEntitlementUsageSnapshot } from '#worker/entitlements/usage-snapshot.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { accountUsageEntitlementResources } from '#worker/entitlements/resource-visibility.ts'

function withUsageEnv(env: { APP_DB: D1Database } & Record<string, unknown>) {
	const meter = createInMemoryUserMeterEnv()
	const runLog = createInMemoryRunLogUsageEnv()
	const repoSessionIndex = createInMemoryRepoSessionIndexEnv(env.APP_DB)
	return {
		...env,
		...meter.env,
		...runLog.env,
		REPO_SESSION_INDEX: repoSessionIndex.REPO_SESSION_INDEX,
		MAILBOX: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ countMessages: async () => ({ total: 0 }) }),
		},
		meter,
		runLog,
	}
}

function createUsageTestDb(input: {
	email: string
	repoCount?: number
	packageCount?: number
	storageBucketEstimates?: Array<number | null>
}) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	return {
		stableUserId,
		db: {
			prepare(query: string) {
				const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
				return {
					bind(...params: Array<unknown>) {
						return {
							async first<T>() {
								if (normalized.includes('from user_repos')) {
									return { count: input.repoCount ?? 0 } as T
								}
								if (normalized.includes('from saved_packages')) {
									return { count: input.packageCount ?? 0 } as T
								}
								if (normalized.includes('select 1 as present from users')) {
									return { present: 1 } as T
								}
								if (
									normalized.includes('count(*)') ||
									normalized.includes('sum(')
								) {
									return { count: 0, total: 0, bytes: 0 } as T
								}
								void params
								return null
							},
							async all<T>() {
								if (normalized.includes('from user_storage_buckets')) {
									if (params[0] !== stableUserId) {
										return { results: [] as Array<T> }
									}
									return {
										results: (input.storageBucketEstimates ?? []).map(
											(estimatedBytes, index) => ({
												storageId: `package-${index}`,
												kind: 'package',
												estimatedBytes,
											}),
										),
									} as { results: Array<T> }
								}
								return { results: [] as Array<T> }
							},
						}
					},
				}
			},
		} as unknown as D1Database,
	}
}

const now = new Date('2026-07-25T12:00:00.000Z')

type Snapshot = Awaited<ReturnType<typeof readEntitlementUsageSnapshot>>

function resource(snapshot: Snapshot, name: string) {
	return snapshot.resources.find((row) => row.resource === name)
}

function hasWarning(snapshot: Snapshot, name: string) {
	return snapshot.warnings.some((row) => row.resource === name)
}

function readSnapshot(
	db: D1Database,
	env: unknown,
	usageUserId: string,
	options: { plan?: 'free' | 'standard'; ladder?: 'public' | 'legacy' } = {},
	at: Date | undefined = now,
) {
	return readEntitlementUsageSnapshot({
		db,
		env: env as Env,
		usageUserId,
		plan: options.plan ?? 'free',
		ladder: options.ladder ?? 'public',
		creditWallet: 'none',
		now: at,
	})
}

test('readEntitlementUsageSnapshot warns at 80% and includes the account resource set', async () => {
	const { stableUserId, db } = createUsageTestDb({
		email: 'warn@example.com',
		packageCount: 7,
		storageBucketEstimates: [2_000, null, 3_000],
	})
	const env = withUsageEnv({ APP_DB: db })
	await env.meter.seed({
		userId: stableUserId,
		resource: 'email_sends_per_day',
		day: utcDayKey(now),
		count: 9,
	})
	await env.meter.seedStorageBytes({ userId: stableUserId, bytes: 1_000 })
	const snapshot = await readSnapshot(db, env, stableUserId)
	expect(resource(snapshot, 'email_sends_per_day')?.overEightyPercent).toBe(
		true,
	)
	expect(hasWarning(snapshot, 'email_sends_per_day')).toBe(true)
	expect(resource(snapshot, 'saved_packages')?.overEightyPercent).toBe(false)
	expect(resource(snapshot, 'storage_bytes')?.current).toBe(6_000)
	expect(snapshot.resources.map((row) => row.resource)).toEqual(
		accountUsageEntitlementResources,
	)
	expect(snapshot.weekStart).toBe('2026-07-20')
	expect(resource(snapshot, 'execute_calls_per_day')?.week).toEqual({
		current: 0,
		limit: 400,
		percentOfLimit: 0,
		overEightyPercent: false,
	})

	const otherUserSnapshot = await readSnapshot(
		db,
		env,
		testStableUserIdFromEmail('other-user@example.com'),
	)
	expect(resource(otherUserSnapshot, 'storage_bytes')?.current).toBe(0)
})

test('readEntitlementUsageSnapshot uses the requested entitlement ladder', async () => {
	const { stableUserId, db } = createUsageTestDb({
		email: 'legacy-usage@example.com',
	})
	const env = withUsageEnv({ APP_DB: db })
	const [publicExecute, legacyExecute] = await Promise.all(
		(['public', 'legacy'] as const).map(async (ladder) =>
			resource(
				await readSnapshot(
					db,
					env,
					stableUserId,
					{ plan: 'standard', ladder },
					undefined,
				),
				'execute_calls_per_day',
			),
		),
	)
	expect(publicExecute?.limit).toBe(planLimits.standard.maxExecuteCallsPerDay)
	expect(legacyExecute?.limit).toBe(
		legacyPlanLimits.standard.maxExecuteCallsPerDay,
	)
	expect(publicExecute?.week?.limit).toBe(
		planLimits.standard.maxExecuteCallsPerWeek,
	)
	expect(legacyExecute?.week).toBeUndefined()
})

test('readEntitlementUsageSnapshot uses one UserMeter RPC for daily, weekly, and storage', async () => {
	const { stableUserId, db } = createUsageTestDb({
		email: 'batch-snapshot@example.com',
		storageBucketEstimates: [1_000],
	})
	const env = withUsageEnv({ APP_DB: db })
	// Warm meters (production usageGet path): every daily key already exists so
	// the snapshot is one RPC with no cold-bootstrap re-read.
	for (const resource of [
		'email_sends_per_day',
		'email_receives_per_day',
		'execute_calls_per_day',
		'outbound_fetches_per_day',
		'job_runs_per_day',
		'automation_invocations_per_day',
	] as const) {
		await env.meter.seed({
			userId: stableUserId,
			resource,
			day: utcDayKey(now),
			count: resource === 'execute_calls_per_day' ? 4 : 0,
		})
	}
	await env.meter.seedStorageBytes({ userId: stableUserId, bytes: 2_000 })
	type MeterStub = {
		read: (input: unknown) => Promise<unknown>
		readRange: (input: unknown) => Promise<unknown>
		readStorageBytes: () => Promise<unknown>
		readUsageSnapshot: (input: unknown) => Promise<unknown>
	}
	const userMeter = env.USER_METER as unknown as {
		get: (id: unknown) => MeterStub
	}
	const realGet = userMeter.get
	const calls = {
		read: 0,
		readRange: 0,
		readStorageBytes: 0,
		readUsageSnapshot: 0,
	}
	userMeter.get = (id) => {
		const meter = realGet(id)
		return {
			...meter,
			async read(input: unknown) {
				calls.read += 1
				return meter.read(input)
			},
			async readRange(input: unknown) {
				calls.readRange += 1
				return meter.readRange(input)
			},
			async readStorageBytes() {
				calls.readStorageBytes += 1
				return meter.readStorageBytes()
			},
			async readUsageSnapshot(input: unknown) {
				calls.readUsageSnapshot += 1
				return meter.readUsageSnapshot(input)
			},
		}
	}

	const snapshot = await readSnapshot(db, env, stableUserId)
	expect(calls).toEqual({
		read: 0,
		readRange: 0,
		readStorageBytes: 0,
		readUsageSnapshot: 1,
	})
	expect(resource(snapshot, 'execute_calls_per_day')?.current).toBe(4)
	expect(resource(snapshot, 'execute_calls_per_day')?.week?.current).toBe(4)
	expect(resource(snapshot, 'storage_bytes')?.current).toBe(3_000)
})

test('readEntitlementUsageSnapshot warns when the weekly window is hotter than today', async () => {
	const { stableUserId, db } = createUsageTestDb({
		email: 'weekly-hot@example.com',
	})
	const env = withUsageEnv({ APP_DB: db })
	for (const [day, count] of [
		['2026-07-20', 330],
		[utcDayKey(now), 10],
	] as const) {
		await env.meter.seed({
			userId: stableUserId,
			resource: 'execute_calls_per_day',
			day,
			count,
		})
	}
	const snapshot = await readSnapshot(db, env, stableUserId)
	const execute = resource(snapshot, 'execute_calls_per_day')
	expect(execute?.current).toBe(10)
	expect(execute?.percentOfLimit).toBe(10 / 150)
	expect(execute?.week).toEqual({
		current: 340,
		limit: 400,
		percentOfLimit: 340 / 400,
		overEightyPercent: true,
	})
	expect(execute?.overEightyPercent).toBe(true)
	expect(hasWarning(snapshot, 'execute_calls_per_day')).toBe(true)
})
