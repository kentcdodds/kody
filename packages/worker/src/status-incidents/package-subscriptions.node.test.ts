import { expect, test, vi } from 'vitest'
import {
	buildStatusIncidentIdempotencyKey,
	buildStatusIncidentOpenedEvent,
	buildStatusIncidentResolvedEvent,
	statusIncidentOpenedTopic,
	statusIncidentResolvedTopic,
} from './subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchAdminPackageSubscriptionEvent: vi.fn(),
}))

vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent:
		mocks.dispatchAdminPackageSubscriptionEvent,
}))

const { dispatchStatusIncidentSubscriptionEvent } =
	await import('./package-subscriptions.ts')

test('status incident dispatch fans metadata-only events through admin package fan-out', async () => {
	const opened = buildStatusIncidentOpenedEvent({
		component: 'app_db',
		detail: 'timeout',
		startedAt: '2026-08-17T01:11:00.000Z',
		statusUrl: 'https://status.kody.codes',
	})
	const resolved = buildStatusIncidentResolvedEvent({
		component: 'app_db',
		detail: 'timeout',
		startedAt: '2026-08-17T01:11:00.000Z',
		resolvedAt: '2026-08-17T01:13:00.000Z',
		statusUrl: 'https://status.kody.codes',
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

	const env = {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
		APP_BASE_URL: 'https://heykody.dev',
	}
	const openedResult = await dispatchStatusIncidentSubscriptionEvent({
		env,
		event: opened,
	})
	const resolvedResult = await dispatchStatusIncidentSubscriptionEvent({
		env,
		event: resolved,
	})

	expect(openedResult[0]).toMatchObject({
		params: opened,
		idempotencyKey: buildStatusIncidentIdempotencyKey({
			event: opened,
			packageId: 'package-1',
		}),
		input: {
			topic: statusIncidentOpenedTopic,
			source: 'status-incidents',
			actorTokenId: 'internal:status-incident-subscriptions',
		},
	})
	expect(resolvedResult[0]).toMatchObject({
		params: resolved,
		idempotencyKey: buildStatusIncidentIdempotencyKey({
			event: resolved,
			packageId: 'package-1',
		}),
		input: {
			topic: statusIncidentResolvedTopic,
			source: 'status-incidents',
		},
	})
	expect(JSON.stringify(openedResult[0]?.params)).not.toContain('user_id')
	expect(JSON.stringify(openedResult[0]?.params)).not.toContain('probe')
})
