import { expect, test } from 'vitest'
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
