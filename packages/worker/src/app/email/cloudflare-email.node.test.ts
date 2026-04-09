import { expect, test, vi } from 'vitest'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'
import {
	captureOutput,
	spawnProcess,
	stopProcess,
	wranglerBin,
} from '#mcp/test-process.ts'
import { sendCloudflareEmail } from './cloudflare-email.ts'

const workerConfig = 'packages/mock-servers/cloudflare/wrangler.jsonc'
const projectRoot = process.cwd()
const mockAccountId = 'cf_account_mock_123'

async function waitForMock(origin: string) {
	const deadline = Date.now() + 25_000
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${origin}/__mocks/meta`)
			if (response.ok) {
				await response.body?.cancel()
				return
			}
		} catch {
			/* retry */
		}
		await delay(200)
	}
	throw new Error('mock cloudflare timeout')
}

async function startCloudflareMock(token: string) {
	const port = await getPort({ host: '127.0.0.1' })
	const origin = `http://127.0.0.1:${port}`
	const inspectorPort = await getPort({ host: '127.0.0.1' })
	const proc = spawnProcess({
		cmd: [
			wranglerBin,
			'dev',
			'--local',
			'--config',
			workerConfig,
			'--var',
			`MOCK_API_TOKEN:${token}`,
			'--port',
			String(port),
			'--inspector-port',
			String(inspectorPort),
			'--ip',
			'127.0.0.1',
			'--show-interactive-dev-session=false',
			'--log-level',
			'error',
		],
		cwd: projectRoot,
	})
	captureOutput(proc.stdout)
	captureOutput(proc.stderr)
	await waitForMock(origin)
	return {
		origin,
		token,
		async [Symbol.asyncDispose]() {
			await stopProcess(proc)
		},
	}
}

test('sendCloudflareEmail posts to the mock Cloudflare email API', async () => {
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

	expect(sendResult.ok).toBe(true)
	expect(sendResult.id).toMatch(/^email_/)

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
})

test('sendCloudflareEmail prefers the binding when available', async () => {
	const calls: Array<unknown> = []
	const result = await sendCloudflareEmail(
		{
			accountId: mockAccountId,
			apiBaseUrl: 'http://127.0.0.1:9',
			apiToken: 'unused',
			binding: {
				async send(message) {
					calls.push(message)
					return {
						success: true,
						messageId: 'binding-message-id',
					}
				},
			},
		},
		{
			to: 'recipient@example.com',
			from: 'reset@kody.dev',
			subject: 'Binding first',
			html: '<p>binding</p>',
		},
	)

	expect(result).toEqual({
		ok: true,
		id: 'binding-message-id',
		error: undefined,
	})
	expect(calls).toHaveLength(1)
})

test('sendCloudflareEmail returns ok false when the Cloudflare API request throws', async () => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = vi.fn(async () => {
		throw new Error('network down')
	}) as typeof fetch

	try {
		const result = await sendCloudflareEmail(
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

		expect(result).toEqual({
			ok: false,
			error: 'network down',
		})
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('sendCloudflareEmail returns ok false when the Cloudflare API returns invalid JSON', async () => {
	const originalFetch = globalThis.fetch
	globalThis.fetch = vi.fn(async () => {
		return new Response('not-json', {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}) as typeof fetch

	try {
		const result = await sendCloudflareEmail(
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
		)

		expect(result).toEqual({
			ok: false,
			error: 'Cloudflare Email API returned an error response.',
		})
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('sendCloudflareEmail redacts skipped email body content from logs', async () => {
	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

	try {
		const result = await sendCloudflareEmail(
			{},
			{
				to: 'recipient@example.com',
				from: 'reset@kody.dev',
				subject: 'Skipped email',
				html: '<p>secret body</p>',
				text: 'secret text',
			},
		)

		expect(result).toEqual({
			ok: false,
			skipped: true,
		})
		expect(warnSpy).toHaveBeenCalledTimes(1)
		const [, payload] = warnSpy.mock.calls[0]!
		expect(String(payload)).not.toContain('secret body')
		expect(String(payload)).not.toContain('secret text')
		expect(String(payload)).toContain('recipient@example.com')
		expect(String(payload)).toContain('Skipped email')
	} finally {
		warnSpy.mockRestore()
	}
})
