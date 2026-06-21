import { expect, test, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
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

	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	try {
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
		expect(warnSpy).toHaveBeenCalledTimes(1)
		const [reason, payload] = warnSpy.mock.calls[0]!
		expect(reason).toBe('cloudflare-email-unconfigured')
		expect(String(payload)).not.toContain('secret body')
		expect(String(payload)).not.toContain('secret text')
		expect(String(payload)).not.toContain('recipient@example.com')
		expect(String(payload)).toContain('***@example.com')
		expect(String(payload)).toContain('Skipped email')
	} finally {
		warnSpy.mockRestore()
	}

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
})
