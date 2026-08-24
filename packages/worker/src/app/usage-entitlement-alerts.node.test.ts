import { expect, test, vi } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import type { FleetEntitlementCrossingSnapshot } from '#worker/admin/fleet-usage-insights.ts'
import {
	consoleWarn,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import type { FleetEntitlementCrossedEvent } from '#worker/usage/fleet-entitlement-crossing-subscription-event.ts'

const loadFleetEntitlementCrossingSnapshots =
	vi.fn<
		(input: {
			db: D1Database
			env: Env
			now: Date
		}) => Promise<Array<FleetEntitlementCrossingSnapshot>>
	>()

vi.mock('#worker/admin/fleet-usage-insights.ts', () => ({
	loadFleetEntitlementCrossingSnapshots: (input: {
		db: D1Database
		env: Env
		now: Date
	}) => loadFleetEntitlementCrossingSnapshots(input),
	adminFleetEntitlementSweepUserLimit: 15,
	fleetRuntimeDurationAlertThresholdMs: 24 * 60 * 60 * 1000,
}))

const dispatchFleetEntitlementCrossingSubscriptionEvent = vi.fn(async () => [])

vi.mock('#worker/usage/fleet-entitlement-crossing-subscriptions.ts', () => ({
	dispatchFleetEntitlementCrossingSubscriptionEvent: (
		...args: Array<unknown>
	) => dispatchFleetEntitlementCrossingSubscriptionEvent(...args),
}))

const {
	emitFleetEntitlementCrossingEvents,
	fleetEntitlementCrossingKvKey,
	shouldRunUsageEntitlementAlertCron,
} = await import('#app/usage-entitlement-alerts.ts')

function createKv() {
	const store = new Map<string, string>()
	return {
		store,
		kv: {
			async get(key: string) {
				return store.get(key) ?? null
			},
			async put(key: string, value: string) {
				store.set(key, value)
			},
			async delete(key: string) {
				store.delete(key)
			},
		} as unknown as KVNamespace,
	}
}

function snapshot(input: {
	stableUserId?: string
	username?: string
	isAdmin?: boolean
	resource?: FleetEntitlementCrossingSnapshot['entitlements'][number]['resource']
	label?: string
	current?: number
	limit?: number
	runtimeDurationMs?: number
}): FleetEntitlementCrossingSnapshot {
	const current = input.current ?? 0
	const limit = input.limit ?? 10
	const percentOfLimit = limit === 0 ? null : current / limit
	return {
		stableUserId: input.stableUserId ?? 'user-a',
		username: input.username ?? 'alice',
		isAdmin: input.isAdmin ?? false,
		entitlements: [
			{
				resource: input.resource ?? 'saved_packages',
				label: input.label ?? 'saved packages',
				current,
				limit,
				percentOfLimit,
				overEightyPercent: percentOfLimit != null && percentOfLimit > 0.8,
			},
		],
		runtimeDurationMs: input.runtimeDurationMs ?? 0,
	}
}

function createEnv(kv?: KVNamespace) {
	return {
		APP_DB: {} as D1Database,
		APP_BASE_URL: 'https://heykody.dev/',
		BUNDLE_ARTIFACTS_KV: kv,
	}
}

test('fleet entitlement crossings emit once per threshold, then rematch after a drop', async () => {
	expect(
		shouldRunUsageEntitlementAlertCron(new Date('2026-08-24T12:00:00.000Z')),
	).toBe(true)
	expect(
		shouldRunUsageEntitlementAlertCron(new Date('2026-08-24T12:05:00.000Z')),
	).toBe(false)

	loadFleetEntitlementCrossingSnapshots.mockResolvedValueOnce([])
	const quiet = await emitFleetEntitlementCrossingEvents({
		env: createEnv(createKv().kv),
	})
	expect(quiet).toEqual({ status: 'no_pressure' })
	expect(
		dispatchFleetEntitlementCrossingSubscriptionEvent,
	).not.toHaveBeenCalled()

	const skipped = await emitFleetEntitlementCrossingEvents({
		env: createEnv(),
	})
	expect(skipped).toEqual({ status: 'skipped', reason: 'no_kv' })

	silenceExpectedConsoleWarns(['fleet-entitlement-crossing-emitted'])
	dispatchFleetEntitlementCrossingSubscriptionEvent.mockResolvedValue([])
	const { kv, store } = createKv()
	const env = createEnv(kv)
	const now = new Date('2026-08-24T12:00:00.000Z')
	loadFleetEntitlementCrossingSnapshots.mockResolvedValue([
		snapshot({ current: 9, limit: 10 }),
	])

	try {
		const first = await emitFleetEntitlementCrossingEvents({ env, now })
		expect(first).toEqual({
			status: 'emitted',
			issueCount: 1,
			crossingCount: 1,
		})
		expect(
			dispatchFleetEntitlementCrossingSubscriptionEvent,
		).toHaveBeenCalledTimes(1)
		const firstEvent = dispatchFleetEntitlementCrossingSubscriptionEvent.mock
			.calls[0]?.[0] as { event: FleetEntitlementCrossedEvent }
		expect(firstEvent.event).toMatchObject({
			event: 'fleet.entitlement.crossed',
			kind: 'entitlement',
			user: { id: 'user-a', username: 'alice' },
			resource: 'saved_packages',
			threshold: 'approaching',
			current: 9,
			limit: 10,
			percent_of_limit: 0.9,
			insights_url: 'https://heykody.dev/admin/insights',
			users_url: 'https://heykody.dev/admin/users',
		})
		expect(firstEvent.event.insights_url).not.toContain('https://heykody.dev//')
		expect(
			store.get(
				fleetEntitlementCrossingKvKey({
					userId: 'user-a',
					crossing: {
						kind: 'entitlement',
						threshold: 'approaching',
						resource: 'saved_packages',
					},
				}),
			),
		).toBe(String(now.getTime()))

		const stillOver = await emitFleetEntitlementCrossingEvents({
			env,
			now: new Date(now.getTime() + 60 * 60 * 1000),
		})
		expect(stillOver).toEqual({ status: 'no_new_crossings', issueCount: 1 })
		expect(
			dispatchFleetEntitlementCrossingSubscriptionEvent,
		).toHaveBeenCalledTimes(1)

		loadFleetEntitlementCrossingSnapshots.mockResolvedValue([
			snapshot({ current: 10, limit: 10 }),
		])
		const reached = await emitFleetEntitlementCrossingEvents({
			env,
			now: new Date('2026-08-24T14:00:00.000Z'),
		})
		expect(reached).toEqual({
			status: 'emitted',
			issueCount: 1,
			crossingCount: 1,
		})
		const reachedEvent = dispatchFleetEntitlementCrossingSubscriptionEvent.mock
			.calls[1]?.[0] as { event: FleetEntitlementCrossedEvent }
		expect(reachedEvent.event).toMatchObject({
			kind: 'entitlement',
			threshold: 'reached',
			current: 10,
			limit: 10,
			percent_of_limit: 1,
		})

		loadFleetEntitlementCrossingSnapshots.mockResolvedValue([
			snapshot({ current: 2, limit: 10 }),
		])
		const dropped = await emitFleetEntitlementCrossingEvents({
			env,
			now: new Date('2026-08-24T15:00:00.000Z'),
		})
		expect(dropped).toEqual({ status: 'no_pressure' })
		expect(
			store.get(
				fleetEntitlementCrossingKvKey({
					userId: 'user-a',
					crossing: {
						kind: 'entitlement',
						threshold: 'approaching',
						resource: 'saved_packages',
					},
				}),
			),
		).toBeUndefined()

		loadFleetEntitlementCrossingSnapshots.mockResolvedValue([
			snapshot({ current: 9, limit: 10 }),
		])
		const reclimbed = await emitFleetEntitlementCrossingEvents({
			env,
			now: new Date('2026-08-24T16:00:00.000Z'),
		})
		expect(reclimbed).toEqual({
			status: 'emitted',
			issueCount: 1,
			crossingCount: 1,
		})
		expect(
			dispatchFleetEntitlementCrossingSubscriptionEvent,
		).toHaveBeenCalledTimes(3)
		expect(consoleWarn).toHaveBeenCalledTimes(3)
	} finally {
		consoleWarn.mockReset()
	}
})

test('a same-hour jump to 100% emits reached once and claims the 80% crossing', async () => {
	silenceExpectedConsoleWarns(['fleet-entitlement-crossing-emitted'])
	dispatchFleetEntitlementCrossingSubscriptionEvent.mockResolvedValue([])
	const { kv, store } = createKv()
	const now = new Date('2026-08-24T12:00:00.000Z')
	loadFleetEntitlementCrossingSnapshots.mockResolvedValue([
		snapshot({ current: 10, limit: 10 }),
	])
	try {
		const result = await emitFleetEntitlementCrossingEvents({
			env: createEnv(kv),
			now,
		})
		expect(result).toEqual({
			status: 'emitted',
			issueCount: 1,
			crossingCount: 1,
		})
		expect(
			dispatchFleetEntitlementCrossingSubscriptionEvent,
		).toHaveBeenCalledTimes(1)
		const event = dispatchFleetEntitlementCrossingSubscriptionEvent.mock
			.calls[0]?.[0] as { event: FleetEntitlementCrossedEvent }
		expect(event.event).toMatchObject({
			threshold: 'reached',
			percent_of_limit: 1,
		})
		expect(
			store.get(
				fleetEntitlementCrossingKvKey({
					userId: 'user-a',
					crossing: {
						kind: 'entitlement',
						threshold: 'reached',
						resource: 'saved_packages',
					},
				}),
			),
		).toBe(String(now.getTime()))
		expect(
			store.get(
				fleetEntitlementCrossingKvKey({
					userId: 'user-a',
					crossing: {
						kind: 'entitlement',
						threshold: 'approaching',
						resource: 'saved_packages',
					},
				}),
			),
		).toBe(String(now.getTime()))

		loadFleetEntitlementCrossingSnapshots.mockResolvedValue([
			snapshot({ current: 9, limit: 10 }),
		])
		const dropToApproaching = await emitFleetEntitlementCrossingEvents({
			env: createEnv(kv),
			now: new Date('2026-08-24T13:00:00.000Z'),
		})
		expect(dropToApproaching).toEqual({
			status: 'no_new_crossings',
			issueCount: 1,
		})
		expect(
			dispatchFleetEntitlementCrossingSubscriptionEvent,
		).toHaveBeenCalledTimes(1)
	} finally {
		consoleWarn.mockReset()
	}
})

test('runtime duration crossings emit once per UTC month and daily resources key by day', async () => {
	silenceExpectedConsoleWarns([
		'fleet-entitlement-crossing-emitted',
		'fleet-entitlement-crossing-dispatch-failed',
	])
	dispatchFleetEntitlementCrossingSubscriptionEvent.mockResolvedValue([])
	const { kv, store } = createKv()
	const now = new Date('2026-08-24T12:00:00.000Z')
	loadFleetEntitlementCrossingSnapshots.mockResolvedValue([
		snapshot({
			resource: 'execute_calls_per_day',
			label: 'execute calls per day',
			current: 250,
			limit: 250,
			runtimeDurationMs: 90_000_000,
		}),
	])
	try {
		const first = await emitFleetEntitlementCrossingEvents({
			env: createEnv(kv),
			now,
		})
		expect(first).toEqual({
			status: 'emitted',
			issueCount: 2,
			crossingCount: 2,
		})
		expect(
			store.get(
				fleetEntitlementCrossingKvKey({
					userId: 'user-a',
					crossing: {
						kind: 'entitlement',
						threshold: 'reached',
						resource: 'execute_calls_per_day',
						day: utcDayKey(now),
					},
				}),
			),
		).toBe(String(now.getTime()))
		expect(
			store.get(
				fleetEntitlementCrossingKvKey({
					userId: 'user-a',
					crossing: {
						kind: 'runtime_duration',
						month: '2026-08',
					},
				}),
			),
		).toBe(String(now.getTime()))

		const sameMonth = await emitFleetEntitlementCrossingEvents({
			env: createEnv(kv),
			now: new Date('2026-08-24T18:00:00.000Z'),
		})
		expect(sameMonth).toEqual({ status: 'no_new_crossings', issueCount: 2 })

		dispatchFleetEntitlementCrossingSubscriptionEvent.mockRejectedValueOnce(
			new Error('fan-out failed'),
		)
		loadFleetEntitlementCrossingSnapshots.mockResolvedValue([
			snapshot({
				stableUserId: 'user-b',
				username: 'bob',
				current: 10,
				limit: 10,
			}),
		])
		const failed = await emitFleetEntitlementCrossingEvents({
			env: createEnv(createKv().kv),
			now: new Date('2026-08-24T19:00:00.000Z'),
		})
		expect(failed).toEqual({ status: 'no_new_crossings', issueCount: 1 })
	} finally {
		consoleWarn.mockReset()
	}
})
