import { expect, test } from 'vitest'
import {
	buildStatusIncidentOpenedPayload,
	buildStatusIncidentResolvedPayload,
	notifyStatusIncidentEvent,
} from './incident-events.ts'

const opened = buildStatusIncidentOpenedPayload({
	component: 'app_db',
	detail: 'timeout',
	startedAt: 1_755_400_000_000,
	statusUrl: 'https://status.kody.codes',
})

test('skips when the shared secret or origin is unset', async () => {
	const unsetSecret = await notifyStatusIncidentEvent({
		primaryOrigin: 'https://kody.codes',
		secret: '  ',
		payload: opened,
		fetchImpl: async () => {
			throw new Error('fetch should not run')
		},
	})
	expect(unsetSecret).toEqual({ ok: true, skipped: 'unset' })

	const unsetOrigin = await notifyStatusIncidentEvent({
		primaryOrigin: '',
		secret: 'shared-secret',
		payload: opened,
		fetchImpl: async () => {
			throw new Error('fetch should not run')
		},
	})
	expect(unsetOrigin).toEqual({ ok: true, skipped: 'unset' })
})

test('rejects non-https origins', async () => {
	const result = await notifyStatusIncidentEvent({
		primaryOrigin: 'http://kody.codes',
		secret: 'shared-secret',
		payload: opened,
		fetchImpl: async () => {
			throw new Error('fetch should not run')
		},
	})
	expect(result).toEqual({ ok: false, error: 'insecure-origin' })
})

test('POSTs opened and resolved payloads to the main-worker maintenance route', async () => {
	const calls: Array<{ url: string; init: RequestInit }> = []
	const resolved = buildStatusIncidentResolvedPayload({
		component: 'app_db',
		detail: 'timeout',
		startedAt: 1_755_400_000_000,
		resolvedAt: 1_755_400_120_000,
		statusUrl: 'https://status.kody.codes',
	})

	const openedResult = await notifyStatusIncidentEvent({
		primaryOrigin: 'https://kody.codes',
		secret: 'shared-secret',
		payload: opened,
		fetchImpl: async (input, init) => {
			calls.push({ url: String(input), init: init ?? {} })
			return new Response(null, { status: 200 })
		},
	})
	const resolvedResult = await notifyStatusIncidentEvent({
		primaryOrigin: 'https://kody.codes/',
		secret: 'shared-secret',
		payload: resolved,
		fetchImpl: async (input, init) => {
			calls.push({ url: String(input), init: init ?? {} })
			return new Response(null, { status: 200 })
		},
	})

	expect(openedResult).toEqual({ ok: true, status: 200 })
	expect(resolvedResult).toEqual({ ok: true, status: 200 })
	expect(calls).toHaveLength(2)
	expect(calls[0]?.url).toBe(
		'https://kody.codes/__maintenance/status-incidents',
	)
	expect(calls[1]?.url).toBe(
		'https://kody.codes/__maintenance/status-incidents',
	)
	expect(calls[0]?.init.method).toBe('POST')
	expect(calls[0]?.init.headers).toMatchObject({
		'content-type': 'application/json',
		authorization: 'Bearer shared-secret',
	})
	expect(calls[0]?.init.body).toBe(JSON.stringify(opened))
	expect(calls[1]?.init.body).toBe(JSON.stringify(resolved))
	expect(opened.incident.started_at).toBe(
		new Date(1_755_400_000_000).toISOString(),
	)
	expect(resolved.incident.resolved_at).toBe(
		new Date(1_755_400_120_000).toISOString(),
	)
})

test('maps non-OK HTTP responses without throwing', async () => {
	const result = await notifyStatusIncidentEvent({
		primaryOrigin: 'https://kody.codes',
		secret: 'shared-secret',
		payload: opened,
		fetchImpl: async () => new Response('nope', { status: 503 }),
	})
	expect(result).toEqual({ ok: false, error: 'http-503' })
})
