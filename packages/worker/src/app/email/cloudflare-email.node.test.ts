import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { consoleInfo, consoleWarn } from '#worker/test-support/console-spies.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { startCloudflareMock } from '#worker/test-support/cloudflare-mock-server.ts'
import { sendCloudflareEmail } from './cloudflare-email.ts'

const mockAccountId = 'cf_account_mock_123'

test('sendCloudflareEmail delivers through the mock API and handles configuration and transport failures', async () => {
	const token = 'cloudflare-email-mock-token'
	await using mock = await startCloudflareMock(token)
	const clearResponse = await fetch(
		`${mock.origin}/__mocks/clear?token=${token}`,
		{
			method: 'POST',
		},
	)
	expect(clearResponse.status).toBe(200)

	const sendResult = await sendCloudflareEmail(
		{
			accountId: mockAccountId,
			apiBaseUrl: mock.origin,
			apiToken: mock.token,
		},
		{
			to: 'recipient@example.com',
			from: 'reset@kody.dev',
			subject: 'Reset your kody password',
			html: '<p>Reset link</p>',
			text: 'Reset link',
		},
	)

	expect(sendResult).toMatchObject({
		ok: true,
	})
	expect(sendResult.messageId).toMatch(/^email_/)

	const response = await fetch(`${mock.origin}/__mocks/messages?token=${token}`)
	expect(response.status).toBe(200)
	const payload = (await response.json()) as {
		count: number
		messages: Array<{
			from_email: string
			subject: string
			text: string | null
		}>
	}
	expect(payload.count).toBe(1)
	expect(payload.messages[0]).toMatchObject({
		from_email: 'reset@kody.dev',
		subject: 'Reset your kody password',
		text: 'Reset link',
	})

	const defaultBaseUrlRequests: Array<Request> = []
	using _defaultBaseUrlServer = createMswNodeServer(
		[
			http.post(
				`https://api.cloudflare.com/client/v4/accounts/${mockAccountId}/email/sending/send`,
				async ({ request }) => {
					defaultBaseUrlRequests.push(request.clone())
					return HttpResponse.json({
						success: true,
						result: {
							delivered: ['recipient@example.com'],
							permanent_bounces: [],
							queued: [],
						},
					})
				},
			),
		],
		{ onUnhandledRequest: 'bypass' },
	)
	const defaultBaseUrlResult = await sendCloudflareEmail(
		{
			accountId: mockAccountId,
			apiToken: 'test-token',
		},
		{
			to: 'recipient@example.com',
			from: 'reset@kody.dev',
			subject: 'Default base URL',
			html: '<p>body</p>',
			text: 'body',
		},
	)
	expect(defaultBaseUrlResult).toMatchObject({ ok: true })
	expect(defaultBaseUrlRequests).toHaveLength(1)
	expect(defaultBaseUrlRequests[0]?.url).toBe(
		`https://api.cloudflare.com/client/v4/accounts/${mockAccountId}/email/sending/send`,
	)

	const skippedResult = await sendCloudflareEmail(
		{},
		{
			to: 'recipient@example.com',
			from: 'reset@kody.dev',
			subject: 'Skipped email',
			html: '<p>secret body</p>',
			text: 'secret text',
		},
	)
	expect(skippedResult).toEqual({
		ok: false,
		skipped: true,
	})
	expect(consoleInfo).toHaveBeenCalledTimes(1)
	const [skipReason, skipPayload] = consoleInfo.mock.calls[0]!
	expect(skipReason).toBe('cloudflare-email-unconfigured')
	expect(String(skipPayload)).not.toContain('secret body')
	expect(String(skipPayload)).not.toContain('secret text')
	expect(String(skipPayload)).not.toContain('recipient@example.com')
	expect(String(skipPayload)).toContain('***@example.com')
	expect(String(skipPayload)).toContain('Skipped email')

	// The transport failure below warns for operators; capture it instead of
	// letting the console guard fail the test.
	consoleWarn.mockImplementation(() => {})
	using _networkFailureServer = createMswNodeServer(
		[http.post('https://api.cloudflare.test/*', () => HttpResponse.error())],
		{ onUnhandledRequest: 'bypass' },
	)
	const networkFailure = await sendCloudflareEmail(
		{
			accountId: mockAccountId,
			apiBaseUrl: 'https://api.cloudflare.test',
			apiToken: 'test-token',
		},
		{
			to: 'recipient@example.com',
			from: 'reset@kody.dev',
			subject: 'Request failure',
			html: '<p>body</p>',
		},
	)
	expect(networkFailure).toEqual({
		ok: false,
		error: 'Failed to fetch',
	})
	// Exactly the one expected warning; anything else the mock swallowed
	// would be a regression hidden by the opt-in above.
	expect(consoleWarn).toHaveBeenCalledTimes(1)
	expect(consoleWarn).toHaveBeenCalledWith(
		'cloudflare-email-api-request-failed',
		expect.any(Error),
	)

	using _invalidJsonServer = createMswNodeServer(
		[
			http.post('https://api.cloudflare.test/*', () =>
				HttpResponse.text('not-json', {
					headers: { 'content-type': 'application/json' },
				}),
			),
		],
		{ onUnhandledRequest: 'bypass' },
	)
	await expect(
		sendCloudflareEmail(
			{
				accountId: mockAccountId,
				apiBaseUrl: 'https://api.cloudflare.test',
				apiToken: 'test-token',
			},
			{
				to: 'recipient@example.com',
				from: 'reset@kody.dev',
				subject: 'Invalid JSON',
				html: '<p>body</p>',
			},
		),
	).rejects.toThrow('not valid JSON')
	// The parse failure throws before any operator warning, so the silenced
	// consoleWarn must not have picked up anything new.
	expect(consoleWarn).toHaveBeenCalledTimes(1)
	expect(consoleInfo).toHaveBeenCalledTimes(1)
}, 75_000)

test('sendCloudflareEmail defaults Reply-To to support@ when From is kody@ unless overridden', async () => {
	const payloads: Array<Record<string, unknown>> = []
	using _server = createMswNodeServer(
		[
			http.post(
				`https://api.cloudflare.test/client/v4/accounts/${mockAccountId}/email/sending/send`,
				async ({ request }) => {
					payloads.push((await request.json()) as Record<string, unknown>)
					return HttpResponse.json({
						success: true,
						result: { message_id: 'reply-to-1' },
					})
				},
			),
		],
		{ onUnhandledRequest: 'bypass' },
	)
	const config = {
		accountId: mockAccountId,
		apiBaseUrl: 'https://api.cloudflare.test',
		apiToken: 'test-token',
	}

	await sendCloudflareEmail(config, {
		to: 'user@example.com',
		from: 'kody@kody.codes',
		subject: 'Verify your email',
		html: '<p>Verify</p>',
		text: 'Verify',
	})
	await sendCloudflareEmail(config, {
		to: 'user@example.com',
		from: 'kody@kody.codes',
		subject: 'Operator override',
		html: '<p>Override</p>',
		text: 'Override',
		replyTo: 'abuse@kody.codes',
	})
	await sendCloudflareEmail(config, {
		to: 'user@example.com',
		from: 'support@kody.codes',
		subject: 'Support sender',
		html: '<p>Support</p>',
		text: 'Support',
	})
	await sendCloudflareEmail(config, {
		to: 'me@example.com',
		from: 'alice@inbox.kody.codes',
		subject: 'User mail',
		html: '<p>User</p>',
		text: 'User',
	})

	expect(payloads).toHaveLength(4)
	expect(payloads[0]).toMatchObject({
		from: 'kody@kody.codes',
		reply_to: 'support@kody.codes',
	})
	expect(payloads[0]).not.toHaveProperty('replyTo')
	expect(payloads[1]).toMatchObject({
		from: 'kody@kody.codes',
		reply_to: 'abuse@kody.codes',
	})
	expect(payloads[1]).not.toHaveProperty('replyTo')
	expect(payloads[2]).toMatchObject({ from: 'support@kody.codes' })
	expect(payloads[2]).not.toHaveProperty('replyTo')
	expect(payloads[2]).not.toHaveProperty('reply_to')
	expect(payloads[3]).toMatchObject({ from: 'alice@inbox.kody.codes' })
	expect(payloads[3]).not.toHaveProperty('replyTo')
	expect(payloads[3]).not.toHaveProperty('reply_to')
})
