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
	const mock = {
		origin,
		token,
		async [Symbol.asyncDispose]() {
			await stopProcess(proc)
		},
	}
	try {
		await waitForMock(origin)
		return mock
	} catch (error) {
		await stopProcess(proc)
		throw error
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
})

test('sendCloudflareEmail defaults the API base URL when it is unset', async () => {
	const originalFetch = globalThis.fetch
	const fetchSpy = vi.fn(async () => {
		return new Response(
			JSON.stringify({
				success: true,
				result: {
					delivered: ['recipient@example.com'],
					permanent_bounces: [],
					queued: [],
				},
			}),
			{
				status: 200,
				headers: { 'content-type': 'application/json' },
			},
		)
	})
	globalThis.fetch = fetchSpy as typeof fetch

	try {
		const result = await sendCloudflareEmail(
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

		expect(result).toMatchObject({
			ok: true,
		})
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		const [input] = fetchSpy.mock.calls[0]!
		expect(String(input)).toBe(
			`https://api.cloudflare.com/client/v4/accounts/${mockAccountId}/email/sending/send`,
		)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('sendCloudflareEmail returns skipped when account or token is missing', async () => {
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
