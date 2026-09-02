import { expect, test, vi } from 'vitest'
import {
	buildFleetPackageErrorRateElevatedEvent,
	buildFleetPackageErrorRateIdempotencyKey,
	fleetPackageErrorRateElevatedTopic,
} from './fleet-package-error-rate-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
}))

vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

const { dispatchFleetPackageErrorRateSubscriptionEvent } =
	await import('./fleet-package-error-rate-subscriptions.ts')

test('fleet package error-rate dispatch fans metadata-only events through admin package fan-out', async () => {
	const event = buildFleetPackageErrorRateElevatedEvent({
		eventId: 'day:2026-08-22T19:00:00.000Z',
		statusUrl: 'https://status.kody.codes',
		insightsUrl: 'https://kody.codes/admin/insights',
		environment: 'production',
		observedAt: '2026-08-22T19:32:00.000Z',
		window: 'day',
		reason: 'absolute_delta',
		recent: {
			start: '2026-08-21T19:00:00.000Z',
			end: '2026-08-22T19:00:00.000Z',
			combined: { events: 80, errors: 16, rate: 0.2 },
			by_metric: [
				{
					metric: 'package_export',
					events: 80,
					errors: 16,
					rate: 0.2,
				},
				{
					metric: 'package_static_call',
					events: 0,
					errors: 0,
					rate: null,
				},
				{ metric: 'job_run', events: 0, errors: 0, rate: null },
				{ metric: 'workflow_run', events: 0, errors: 0, rate: null },
			],
		},
		previous: {
			start: '2026-08-20T19:00:00.000Z',
			end: '2026-08-21T19:00:00.000Z',
			combined: { events: 80, errors: 2, rate: 0.025 },
			by_metric: [
				{
					metric: 'package_export',
					events: 80,
					errors: 2,
					rate: 0.025,
				},
				{
					metric: 'package_static_call',
					events: 0,
					errors: 0,
					rate: null,
				},
				{ metric: 'job_run', events: 0, errors: 0, rate: null },
				{ metric: 'workflow_run', events: 0, errors: 0, rate: null },
			],
		},
	})

	mocks.dispatchAdminPackageSubscriptionEvent.mockImplementation(
		async (input: {
			getParams: () =>
				| Record<string, unknown>
				| Promise<Record<string, unknown>>
			buildIdempotencyKey: (savedPackage: { id: string }) => string
			[key: string]: unknown
		}) => [
			{
				params: await input.getParams(),
				idempotencyKey: input.buildIdempotencyKey({ id: 'package-1' }),
				input,
			},
		],
	)

	const result = await dispatchFleetPackageErrorRateSubscriptionEvent({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			APP_BASE_URL: 'https://kody.codes',
		},
		event,
	})

	expect(result[0]).toMatchObject({
		params: event,
		idempotencyKey: buildFleetPackageErrorRateIdempotencyKey({
			event,
			packageId: 'package-1',
		}),
		input: {
			topic: fleetPackageErrorRateElevatedTopic,
			source: 'fleet-package-error-rate',
			actorTokenId: 'internal:fleet-package-error-rate-subscriptions',
		},
	})
	expect(event.concentration).toBeNull()
	expect(JSON.stringify(result[0]?.params)).not.toContain('user_id')
	expect(JSON.stringify(result[0]?.params)).not.toContain('error_message')
})
