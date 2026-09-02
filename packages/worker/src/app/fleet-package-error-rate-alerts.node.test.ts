import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { fleetPackageErrorRateKvKey } from '#worker/usage/fleet-package-error-rate.ts'

const queryAnalyticsEngineSql = vi.fn()
const dispatchFleetPackageErrorRateSubscriptionEvent = vi.fn(async () => [])

vi.mock('#worker/usage/aggregate-rollups.ts', async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>
	return {
		...original,
		queryAnalyticsEngineSql: (...args: Array<unknown>) =>
			queryAnalyticsEngineSql(...args),
	}
})

vi.mock('#worker/usage/fleet-package-error-rate-subscriptions.ts', () => ({
	dispatchFleetPackageErrorRateSubscriptionEvent: (...args: Array<unknown>) =>
		dispatchFleetPackageErrorRateSubscriptionEvent(...args),
}))

const {
	fleetPackageErrorRateAlertKvKey,
	refreshFleetPackageErrorRateAndMaybeAlert,
} = await import('./fleet-package-error-rate-alerts.ts')

function createKv(stored = new Map<string, string>()) {
	return {
		stored,
		kv: {
			async get(key: string, type?: string) {
				const value = stored.get(key) ?? null
				if (value == null) return null
				return type === 'json' ? JSON.parse(value) : value
			},
			async put(key: string, value: string) {
				stored.set(key, value)
			},
		} as unknown as KVNamespace,
	}
}

test('refreshFleetPackageErrorRateAndMaybeAlert writes a content-free snapshot and pages once', async () => {
	consoleWarn.mockImplementation(() => {})
	const { stored, kv } = createKv()

	queryAnalyticsEngineSql.mockImplementation(
		async (input: { query: string }) => {
			if (input.query.includes("toDateTime('2026-08-21 19:00:00')")) {
				return [
					{
						window: 'recent',
						metric: 'package_export',
						event_count: 80,
						error_count: 16,
					},
					{
						window: 'previous',
						metric: 'package_export',
						event_count: 80,
						error_count: 2,
					},
				]
			}
			return [
				{
					window: 'recent',
					metric: 'package_export',
					event_count: 40,
					error_count: 2,
				},
				{
					window: 'previous',
					metric: 'package_export',
					event_count: 40,
					error_count: 1,
				},
			]
		},
	)

	const now = new Date('2026-08-22T19:32:00.000Z')
	const env = {
		USAGE_EVENTS: {} as AnalyticsEngineDataset,
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: kv,
		APP_BASE_URL: 'https://kody.codes',
		CLOUDFLARE_ACCOUNT_ID: 'account',
		CLOUDFLARE_API_TOKEN: 'token',
		SENTRY_ENVIRONMENT: 'production',
	}
	const first = await refreshFleetPackageErrorRateAndMaybeAlert({
		env,
		now,
	})
	expect(first).toMatchObject({
		status: 'refreshed',
		elevated: true,
		alert: { status: 'notified', eventId: 'day:2026-08-22T19:00:00.000Z' },
	})
	expect(dispatchFleetPackageErrorRateSubscriptionEvent).toHaveBeenCalledTimes(
		1,
	)
	const dispatched = dispatchFleetPackageErrorRateSubscriptionEvent.mock
		.calls[0]?.[0] as { event: Record<string, unknown> }
	const payload = JSON.stringify(dispatched.event)
	expect(payload).not.toContain('user_id')
	expect(payload).not.toContain('admin@example.com')
	expect(payload).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
	expect(dispatched.event.event).toBe('fleet.package_error_rate.elevated')
	expect(dispatched.event.concentration).toBeNull()

	const snapshot = JSON.parse(stored.get(fleetPackageErrorRateKvKey) ?? 'null')
	expect(snapshot?.environment).toBe('production')
	expect(snapshot?.day.recent.combined.errors).toBe(16)
	expect(snapshot?.lastAlertEventId).toBe('day:2026-08-22T19:00:00.000Z')
	expect(snapshot?.concentration).toBeNull()

	const second = await refreshFleetPackageErrorRateAndMaybeAlert({
		env,
		now: new Date('2026-08-22T20:05:00.000Z'),
	})
	expect(second).toMatchObject({
		status: 'refreshed',
		elevated: true,
		alert: { status: 'cooldown' },
	})
	expect(dispatchFleetPackageErrorRateSubscriptionEvent).toHaveBeenCalledTimes(
		1,
	)
	expect(stored.get(fleetPackageErrorRateAlertKvKey)).toBe(
		String(now.getTime()),
	)

	await expect(
		refreshFleetPackageErrorRateAndMaybeAlert({
			env: { BUNDLE_ARTIFACTS_KV: {} as KVNamespace },
		}),
	).resolves.toEqual({
		status: 'skipped',
		reason: 'missing-analytics-config',
	})

	dispatchFleetPackageErrorRateSubscriptionEvent.mockClear()
	dispatchFleetPackageErrorRateSubscriptionEvent.mockRejectedValueOnce(
		new Error('fan-out failed'),
	)
	const failedKv = createKv()
	queryAnalyticsEngineSql.mockResolvedValue([
		{
			window: 'recent',
			metric: 'package_export',
			event_count: 80,
			error_count: 16,
		},
		{
			window: 'previous',
			metric: 'package_export',
			event_count: 80,
			error_count: 2,
		},
	])
	const skipped = await refreshFleetPackageErrorRateAndMaybeAlert({
		env: {
			USAGE_EVENTS: {} as AnalyticsEngineDataset,
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: failedKv.kv,
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
			SENTRY_ENVIRONMENT: 'production',
		},
		now: new Date('2026-08-22T19:32:00.000Z'),
	})
	expect(skipped).toMatchObject({
		status: 'refreshed',
		elevated: true,
		alert: { status: 'skipped', reason: 'notify_failed' },
	})
	expect(failedKv.stored.get(fleetPackageErrorRateAlertKvKey)).toBeUndefined()
})

test('refreshFleetPackageErrorRateAndMaybeAlert names a one-account concentration without leaking identifiers', async () => {
	consoleWarn.mockImplementation(() => {})
	dispatchFleetPackageErrorRateSubscriptionEvent.mockClear()
	const { stored, kv } = createKv()
	const jettPackageIds = {
		dji: '11111111-1111-4111-8111-111111111111',
		earth: '22222222-2222-4222-8222-222222222222',
		analysis: '33333333-3333-4333-8333-333333333333',
	}
	queryAnalyticsEngineSql.mockImplementation(
		async (input: { query: string }) => {
			if (input.query.includes('blob1 AS user_id')) {
				return [
					{
						user_id: 'jett-user',
						entity_id: jettPackageIds.dji,
						error_count: 40,
					},
					{
						user_id: 'jett-user',
						entity_id: jettPackageIds.earth,
						error_count: 30,
					},
					{
						user_id: 'jett-user',
						entity_id: jettPackageIds.analysis,
						error_count: 20,
					},
				]
			}
			if (input.query.includes("toDateTime('2026-08-21 19:00:00')")) {
				return [
					{
						window: 'recent',
						metric: 'package_export',
						event_count: 80,
						error_count: 16,
					},
					{
						window: 'previous',
						metric: 'package_export',
						event_count: 80,
						error_count: 2,
					},
				]
			}
			return [
				{
					window: 'recent',
					metric: 'package_export',
					event_count: 40,
					error_count: 2,
				},
				{
					window: 'previous',
					metric: 'package_export',
					event_count: 40,
					error_count: 1,
				},
			]
		},
	)
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async all() {
							if (query.includes('FROM users')) {
								return {
									results: params.includes('jett-user')
										? [
												{
													stable_user_id: 'jett-user',
													username: 'jett',
												},
											]
										: [],
								}
							}
							if (query.includes('FROM saved_packages')) {
								const kodyIds: Record<string, string> = {
									[jettPackageIds.dji]: 'dji-cloud-relay-staging-deploy',
									[jettPackageIds.earth]: 'earthranger-relay-staging-deploy',
									[jettPackageIds.analysis]: 'analysis-staging-deploy',
								}
								return {
									results: params
										.filter((id): id is string => typeof id === 'string')
										.flatMap((id) =>
											kodyIds[id] ? [{ id, kody_id: kodyIds[id] }] : [],
										),
								}
							}
							return { results: [] }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const result = await refreshFleetPackageErrorRateAndMaybeAlert({
		env: {
			USAGE_EVENTS: {} as AnalyticsEngineDataset,
			APP_DB: db,
			BUNDLE_ARTIFACTS_KV: kv,
			APP_BASE_URL: 'https://kody.codes',
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
			SENTRY_ENVIRONMENT: 'production',
		},
		now: new Date('2026-08-22T19:32:00.000Z'),
	})
	expect(result).toMatchObject({
		status: 'refreshed',
		elevated: true,
		alert: { status: 'notified' },
	})
	const dispatched =
		dispatchFleetPackageErrorRateSubscriptionEvent.mock.calls.at(-1)?.[0] as {
			event: Record<string, unknown>
		}
	const payload = JSON.stringify(dispatched.event)
	expect(dispatched.event.concentration).toMatchObject({
		kind: 'one_account',
		owners: [
			{
				username: 'jett',
				packages: [
					{ kody_id: 'dji-cloud-relay-staging-deploy' },
					{ kody_id: 'earthranger-relay-staging-deploy' },
					{ kody_id: 'analysis-staging-deploy' },
				],
			},
		],
	})
	expect(payload).toContain('jett')
	expect(payload).toContain('dji-cloud-relay-staging-deploy')
	expect(payload).not.toContain('user_id')
	expect(payload).not.toContain('jett-user')
	expect(payload).not.toContain('admin@example.com')
	expect(payload).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
	expect(consoleWarn).toHaveBeenCalledWith(
		'fleet-package-error-rate-alerted',
		expect.objectContaining({
			concentration:
				'One account owns 100% of recent errors (jett: dji-cloud-relay-staging-deploy, earthranger-relay-staging-deploy, analysis-staging-deploy).',
		}),
	)
	const snapshot = JSON.parse(stored.get(fleetPackageErrorRateKvKey) ?? 'null')
	expect(snapshot?.concentration?.kind).toBe('one_account')
	expect(JSON.stringify(snapshot)).not.toContain('user_id')
	expect(JSON.stringify(snapshot)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
})
