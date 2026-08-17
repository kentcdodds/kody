import { expect, test } from 'vitest'
import {
	notifyStatusIncidentOpened,
	type StatusIncidentOpenedPayload,
} from './incident-webhook.ts'

const payload: StatusIncidentOpenedPayload = {
	event: 'incident.opened',
	component: 'audit_db',
	detail: 'timeout',
	startedAt: 1_755_400_000_000,
	statusUrl: 'https://status.kody.codes',
}

test('skips when the webhook URL is unset', async () => {
	const result = await notifyStatusIncidentOpened({
		webhookUrl: '  ',
		payload,
		fetchImpl: async () => {
			throw new Error('fetch should not run')
		},
	})
	expect(result).toEqual({ ok: true, skipped: 'unset' })
})

test('rejects non-https webhook URLs', async () => {
	const result = await notifyStatusIncidentOpened({
		webhookUrl: 'http://example.com/hook',
		payload,
		fetchImpl: async () => {
			throw new Error('fetch should not run')
		},
	})
	expect(result).toEqual({ ok: false, error: 'insecure-url' })
})

test('POSTs the incident payload and returns the status', async () => {
	const calls: Array<{ url: string; init: RequestInit }> = []
	const result = await notifyStatusIncidentOpened({
		webhookUrl:
			'https://kody.codes/@kentcdodds/webhooks/status-incident-triage/incident/secret',
		payload,
		fetchImpl: async (input, init) => {
			calls.push({ url: String(input), init: init ?? {} })
			return new Response(null, { status: 202 })
		},
	})
	expect(result).toEqual({ ok: true, status: 202 })
	expect(calls).toHaveLength(1)
	expect(calls[0]?.init.method).toBe('POST')
	expect(calls[0]?.init.body).toBe(JSON.stringify(payload))
})

test('maps non-OK HTTP responses without throwing', async () => {
	const result = await notifyStatusIncidentOpened({
		webhookUrl: 'https://kody.codes/hook',
		payload,
		fetchImpl: async () => new Response('nope', { status: 503 }),
	})
	expect(result).toEqual({ ok: false, error: 'http-503' })
})
