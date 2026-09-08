import { expect, test } from 'vitest'
import { sendAlertEmail } from './alert-email.ts'

test('sendAlertEmail defaults Reply-To to support@ when From is kody@ unless overridden', async () => {
	const payloads: Array<Record<string, unknown>> = []
	const fetcher: typeof fetch = async (_input, init) => {
		payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
		return Response.json({ success: true })
	}

	await sendAlertEmail(
		{
			accountId: 'account-123',
			apiToken: 'token-123',
			apiBaseUrl: 'https://api.cloudflare.test',
			fetcher,
		},
		{
			from: 'kody@kody.codes',
			to: 'ops@example.com',
			subject: 'Incident',
			text: 'App is down',
			html: '<p>App is down</p>',
		},
	)
	await sendAlertEmail(
		{
			accountId: 'account-123',
			apiToken: 'token-123',
			apiBaseUrl: 'https://api.cloudflare.test',
			fetcher,
		},
		{
			from: 'kody@kody.codes',
			to: 'ops@example.com',
			subject: 'Override',
			text: 'Still down',
			html: '<p>Still down</p>',
			replyTo: 'security@kody.codes',
		},
	)
	await sendAlertEmail(
		{
			accountId: 'account-123',
			apiToken: 'token-123',
			apiBaseUrl: 'https://api.cloudflare.test',
			fetcher,
		},
		{
			from: 'status@example.com',
			to: 'ops@example.com',
			subject: 'Other sender',
			text: 'Ok',
			html: '<p>Ok</p>',
		},
	)

	expect(payloads).toEqual([
		{
			from: 'kody@kody.codes',
			to: 'ops@example.com',
			subject: 'Incident',
			text: 'App is down',
			html: '<p>App is down</p>',
			reply_to: 'support@kody.codes',
		},
		{
			from: 'kody@kody.codes',
			to: 'ops@example.com',
			subject: 'Override',
			text: 'Still down',
			html: '<p>Still down</p>',
			reply_to: 'security@kody.codes',
		},
		{
			from: 'status@example.com',
			to: 'ops@example.com',
			subject: 'Other sender',
			text: 'Ok',
			html: '<p>Ok</p>',
		},
	])
	expect(payloads[0]).not.toHaveProperty('replyTo')
	expect(payloads[1]).not.toHaveProperty('replyTo')
	expect(payloads[2]).not.toHaveProperty('replyTo')
	expect(payloads[2]).not.toHaveProperty('reply_to')
})
