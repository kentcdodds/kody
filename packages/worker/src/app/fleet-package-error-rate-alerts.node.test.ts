import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	countsOf,
	fleetPackageErrorRateKvKey,
	toWindowSnapshot,
} from '#worker/usage/fleet-package-error-rate.ts'

const queryAnalyticsEngineSql = vi.fn()
const sendCloudflareEmail = vi.fn(async () => ({ ok: true }))
const dispatchFleetPackageErrorRateSubscriptionEvent = vi.fn(async () => [])

vi.mock('#worker/usage/aggregate-rollups.ts', async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>
	return {
		...original,
		queryAnalyticsEngineSql: (...args: Array<unknown>) =>
			queryAnalyticsEngineSql(...args),
	}
})

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		sendCloudflareEmail(...args),
}))

vi.mock('#worker/usage/fleet-package-error-rate-subscriptions.ts', () => ({
	dispatchFleetPackageErrorRateSubscriptionEvent: (...args: Array<unknown>) =>
		dispatchFleetPackageErrorRateSubscriptionEvent(...args),
}))

const {
	fleetPackageErrorRateAlertKvKey,
	formatFleetPackageErrorRateAlertText,
	refreshFleetPackageErrorRateAndMaybeAlert,
} = await import('./fleet-package-error-rate-alerts.ts')

function windowOf(input: {
	kind: 'hour' | 'day'
	recentEvents: number
	recentErrors: number
	previousEvents: number
	previousErrors: number
}) {
	const recentStart = new Date('2026-08-22T18:00:00.000Z')
	const recentEnd = new Date('2026-08-22T19:00:00.000Z')
	const previousStart = new Date('2026-08-22T17:00:00.000Z')
	return {
		kind: input.kind,
		recent: toWindowSnapshot({
			start: recentStart,
			end: recentEnd,
			byMetric: {
				package_export: countsOf(input.recentEvents, input.recentErrors),
				package_static_call: countsOf(0, 0),
				job_run: countsOf(0, 0),
				workflow_run: countsOf(0, 0),
			},
		}),
		previous: toWindowSnapshot({
			start: previousStart,
			end: recentStart,
			byMetric: {
				package_export: countsOf(input.previousEvents, input.previousErrors),
				package_static_call: countsOf(0, 0),
				job_run: countsOf(0, 0),
				workflow_run: countsOf(0, 0),
			},
		}),
	}
}

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

function createDb() {
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind() {
					return this
				},
				async all<T>() {
					if (normalized.includes('from users u')) {
						return { results: [{ email: 'admin@example.com' }] } as {
							results: Array<T>
						}
					}
					return { results: [] }
				},
			}
		},
	} as unknown as D1Database
}

test('refreshFleetPackageErrorRateAndMaybeAlert writes a content-free snapshot and pages once', async () => {
	consoleWarn.mockImplementation(() => {})
	const { stored, kv } = createKv()
	const db = createDb()

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
		APP_DB: db,
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
		alert: { status: 'notified', recipients: 1 },
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
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)

	const snapshot = JSON.parse(stored.get(fleetPackageErrorRateKvKey) ?? 'null')
	expect(snapshot?.environment).toBe('production')
	expect(snapshot?.day.recent.combined.errors).toBe(16)
	expect(snapshot?.lastAlertEventId).toBe('day:2026-08-22T19:00:00.000Z')

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
})

test('refreshFleetPackageErrorRateAndMaybeAlert skips without Analytics Engine config', async () => {
	await expect(
		refreshFleetPackageErrorRateAndMaybeAlert({
			env: { BUNDLE_ARTIFACTS_KV: {} as KVNamespace },
		}),
	).resolves.toEqual({
		status: 'skipped',
		reason: 'missing-analytics-config',
	})
})

test('refreshFleetPackageErrorRateAndMaybeAlert does not cool down when no admin can be emailed', async () => {
	consoleWarn.mockImplementation(() => {})
	sendCloudflareEmail.mockClear()
	dispatchFleetPackageErrorRateSubscriptionEvent.mockClear()
	const { stored, kv } = createKv()
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
	const result = await refreshFleetPackageErrorRateAndMaybeAlert({
		env: {
			USAGE_EVENTS: {} as AnalyticsEngineDataset,
			APP_DB: {
				prepare() {
					return {
						async all() {
							return { results: [] }
						},
					}
				},
			} as unknown as D1Database,
			BUNDLE_ARTIFACTS_KV: kv,
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
			SENTRY_ENVIRONMENT: 'production',
		},
		now: new Date('2026-08-22T19:32:00.000Z'),
	})
	expect(result).toMatchObject({
		status: 'refreshed',
		elevated: true,
		alert: { status: 'skipped', reason: 'no_system_domain' },
	})
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect(stored.get(fleetPackageErrorRateAlertKvKey)).toBeUndefined()
})

test('formatFleetPackageErrorRateAlertText stays content-free', () => {
	const text = formatFleetPackageErrorRateAlertText({
		event: 'fleet.package_error_rate.elevated',
		event_id: 'day:2026-08-22T19:00:00.000Z',
		status_url: 'https://status.kody.codes',
		insights_url: 'https://kody.codes/admin/insights',
		environment: 'production',
		observed_at: '2026-08-22T19:32:00.000Z',
		trigger: {
			window: 'day',
			reason: 'absolute_delta',
			recent: windowOf({
				kind: 'day',
				recentEvents: 80,
				recentErrors: 16,
				previousEvents: 80,
				previousErrors: 2,
			}).recent,
			previous: windowOf({
				kind: 'day',
				recentEvents: 80,
				recentErrors: 16,
				previousEvents: 80,
				previousErrors: 2,
			}).previous,
		},
		by_metric: windowOf({
			kind: 'day',
			recentEvents: 80,
			recentErrors: 16,
			previousEvents: 80,
			previousErrors: 2,
		}).recent.by_metric,
	})
	expect(text).toContain('16/80')
	expect(text).toContain('user-package')
	expect(text).not.toContain('user_id')
	expect(text).not.toContain('admin@')
})
