import { expect, test } from 'vitest'
import {
	buildStatusIncidentOpenedPayload,
	buildStatusIncidentResolvedPayload,
	notifyStatusIncidentEvent,
} from './incident-events.ts'

test('status incident notify skips unset config, rejects insecure origins, and POSTs opened/resolved payloads', async () => {
	const incident = {
		component: 'app_db',
		detail: 'timeout',
		startedAt: 1_755_400_000_000,
		statusUrl: 'https://status.kody.codes',
	} as const
	const opened = buildStatusIncidentOpenedPayload(incident)
	const resolved = buildStatusIncidentResolvedPayload({
		...incident,
		resolvedAt: 1_755_400_120_000,
	})

	const calls: Array<{ url: string; init: RequestInit }> = []
	const notify = (
		primaryOrigin: string,
		secret: string,
		payload: typeof opened | typeof resolved = opened,
		response = () => new Response(null, { status: 200 }),
	) =>
		notifyStatusIncidentEvent({
			primaryOrigin,
			secret,
			payload,
			fetchImpl: async (input, init) => {
				calls.push({ url: String(input), init: init ?? {} })
				return response()
			},
		})

	expect(await notify('https://kody.codes', '  ')).toEqual({
		ok: true,
		skipped: 'unset',
	})
	expect(await notify('', 'shared-secret')).toEqual({
		ok: true,
		skipped: 'unset',
	})
	expect(await notify('http://kody.codes', 'shared-secret')).toEqual({
		ok: false,
		error: 'insecure-origin',
	})
	expect(calls).toEqual([])

	expect(await notify('https://kody.codes', 'shared-secret')).toEqual({
		ok: true,
		status: 200,
	})
	expect(
		await notify('https://kody.codes/', 'shared-secret', resolved),
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
		await notify(
			'https://kody.codes',
			'shared-secret',
			opened,
			() => new Response('nope', { status: 503 }),
		),
	).toEqual({ ok: false, error: 'http-503' })
})
