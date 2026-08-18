import { expect, test } from 'vitest'
import {
	buildStatusIncidentOpenedPayload,
	buildStatusIncidentResolvedPayload,
	notifyStatusIncidentEvent,
} from './incident-events.ts'

test('status incident notify skips unset config, rejects insecure origins, and POSTs opened/resolved payloads', async () => {
	const opened = buildStatusIncidentOpenedPayload({
		component: 'app_db',
		detail: 'timeout',
		startedAt: 1_755_400_000_000,
		statusUrl: 'https://status.kody.codes',
	})
	const resolved = buildStatusIncidentResolvedPayload({
		component: 'app_db',
		detail: 'timeout',
		startedAt: 1_755_400_000_000,
		resolvedAt: 1_755_400_120_000,
		statusUrl: 'https://status.kody.codes',
	})

	expect(
		await notifyStatusIncidentEvent({
			primaryOrigin: 'https://kody.codes',
			secret: '  ',
			payload: opened,
			fetchImpl: async () => {
				throw new Error('fetch should not run')
			},
		}),
	).toEqual({ ok: true, skipped: 'unset' })
	expect(
		await notifyStatusIncidentEvent({
			primaryOrigin: '',
			secret: 'shared-secret',
			payload: opened,
			fetchImpl: async () => {
				throw new Error('fetch should not run')
			},
		}),
	).toEqual({ ok: true, skipped: 'unset' })
	expect(
		await notifyStatusIncidentEvent({
			primaryOrigin: 'http://kody.codes',
			secret: 'shared-secret',
			payload: opened,
			fetchImpl: async () => {
				throw new Error('fetch should not run')
			},
		}),
	).toEqual({ ok: false, error: 'insecure-origin' })

	const calls: Array<{ url: string; init: RequestInit }> = []
	expect(
		await notifyStatusIncidentEvent({
			primaryOrigin: 'https://kody.codes',
			secret: 'shared-secret',
			payload: opened,
			fetchImpl: async (input, init) => {
				calls.push({ url: String(input), init: init ?? {} })
				return new Response(null, { status: 200 })
			},
		}),
	).toEqual({ ok: true, status: 200 })
	expect(
		await notifyStatusIncidentEvent({
			primaryOrigin: 'https://kody.codes/',
			secret: 'shared-secret',
			payload: resolved,
			fetchImpl: async (input, init) => {
				calls.push({ url: String(input), init: init ?? {} })
				return new Response(null, { status: 200 })
			},
		}),
	).toEqual({ ok: true, status: 200 })
	expect(calls).toHaveLength(2)
	expect(calls[0]?.url).toBe(
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

	expect(
		await notifyStatusIncidentEvent({
			primaryOrigin: 'https://kody.codes',
			secret: 'shared-secret',
			payload: opened,
			fetchImpl: async () => new Response('nope', { status: 503 }),
		}),
	).toEqual({ ok: false, error: 'http-503' })
})
