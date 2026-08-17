import { expect, test, vi } from 'vitest'
import { buildStatusIncidentOpenedEvent } from './subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchStatusIncidentSubscriptionEvent: vi.fn(),
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchStatusIncidentSubscriptionEvent:
		mocks.dispatchStatusIncidentSubscriptionEvent,
}))

const { handleStatusIncidentEventRequest, statusIncidentEventPath } =
	await import('./maintenance.ts')

function createRequest(input: {
	method?: string
	secret?: string
	body?: unknown
}) {
	const headers = new Headers({ 'content-type': 'application/json' })
	if (input.secret) headers.set('Authorization', `Bearer ${input.secret}`)
	return new Request(`https://kody.example.com${statusIncidentEventPath}`, {
		method: input.method ?? 'POST',
		headers,
		body: input.method === 'GET' ? undefined : JSON.stringify(input.body ?? {}),
	})
}

test('status incident maintenance route authenticates, validates, and fans out in the background', async () => {
	const opened = buildStatusIncidentOpenedEvent({
		component: 'app_db',
		detail: 'timeout',
		startedAt: '2026-08-17T01:11:00.000Z',
		statusUrl: 'https://status.kody.codes',
	})
	const pending: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			pending.push(promise)
		},
	}
	const env = {
		STATUS_INCIDENT_EVENT_SECRET: 'shared-secret',
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
		APP_BASE_URL: 'https://heykody.dev',
	} as Env

	const methodResponse = await handleStatusIncidentEventRequest(
		createRequest({ method: 'GET' }),
		env,
		ctx,
	)
	expect(methodResponse.status).toBe(405)

	const unconfiguredResponse = await handleStatusIncidentEventRequest(
		createRequest({ secret: 'shared-secret', body: opened }),
		{ ...env, STATUS_INCIDENT_EVENT_SECRET: undefined },
		ctx,
	)
	expect(unconfiguredResponse.status).toBe(503)

	const unauthorizedResponse = await handleStatusIncidentEventRequest(
		createRequest({ secret: 'wrong', body: opened }),
		env,
		ctx,
	)
	expect(unauthorizedResponse.status).toBe(401)

	const invalidResponse = await handleStatusIncidentEventRequest(
		createRequest({ secret: 'shared-secret', body: { event: 'nope' } }),
		env,
		ctx,
	)
	expect(invalidResponse.status).toBe(400)
	await expect(invalidResponse.json()).resolves.toEqual({
		ok: false,
		error: 'invalid-event',
	})

	mocks.dispatchStatusIncidentSubscriptionEvent.mockResolvedValue([])
	const accepted = await handleStatusIncidentEventRequest(
		createRequest({ secret: 'shared-secret', body: opened }),
		env,
		ctx,
	)
	expect(accepted.status).toBe(200)
	await expect(accepted.json()).resolves.toEqual({
		ok: true,
		accepted: true,
		event: opened.event,
	})
	await Promise.all(pending)
	expect(mocks.dispatchStatusIncidentSubscriptionEvent).toHaveBeenCalledWith({
		env,
		event: opened,
		waitUntil: ctx.waitUntil,
	})
})
