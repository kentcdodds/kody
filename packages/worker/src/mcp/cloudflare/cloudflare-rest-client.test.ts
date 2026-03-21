/// <reference types="bun" />
import { expect, test } from 'bun:test'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'
import {
	createCloudflareRestClient,
	CloudflareRestClient,
} from './cloudflare-rest-client.ts'

const workerConfig = 'packages/mock-servers/cloudflare/wrangler.jsonc'
const bunBin = process.execPath
const projectRoot = process.cwd()
const timeoutMs = 60_000

function captureOutput(stream: ReadableStream<Uint8Array> | null) {
	if (!stream) return
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	void (async () => {
		try {
			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				void decoder.decode(value)
			}
		} catch {
			// ignore
		}
	})()
}

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
	const proc = Bun.spawn({
		cmd: [
			bunBin,
			'x',
			'wrangler',
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
		stdout: 'pipe',
		stderr: 'pipe',
	})
	captureOutput(proc.stdout)
	captureOutput(proc.stderr)
	await waitForMock(origin)
	return {
		origin,
		token,
		async [Symbol.asyncDispose]() {
			proc.kill('SIGINT')
			await Promise.race([proc.exited, delay(5000)])
			if (proc.exitCode === null) proc.kill('SIGKILL')
			await proc.exited
		},
	}
}

test(
	'CloudflareRestClient rawRequest reads accounts from the mock',
	async () => {
		const token = 'cloudflare-client-mock-token'
		await using mock = await startCloudflareMock(token)
		const client = new CloudflareRestClient({
			apiToken: mock.token,
			baseUrl: mock.origin,
		})
		const response = await client.rawRequest({
			method: 'GET',
			path: '/client/v4/accounts',
		})
		expect(response.status).toBe(200)
		const body = response.body as {
			success?: boolean
			result?: Array<{ id?: string }>
		}
		expect(body.success).toBe(true)
		expect(
			body.result?.some((account) => account.id === 'cf_account_mock_123'),
		).toBe(true)
	},
	{ timeout: timeoutMs },
)

test(
	'createCloudflareRestClient uses CLOUDFLARE_API_BASE_URL for rawRequest',
	async () => {
		const token = 'cloudflare-client-env-token'
		await using mock = await startCloudflareMock(token)
		const client = createCloudflareRestClient({
			CLOUDFLARE_API_TOKEN: mock.token,
			CLOUDFLARE_API_BASE_URL: mock.origin,
		} as Pick<Env, 'CLOUDFLARE_API_TOKEN' | 'CLOUDFLARE_API_BASE_URL'>)
		const response = await client.rawRequest({
			method: 'GET',
			path: '/client/v4/user/tokens/verify',
		})
		expect(response.status).toBe(200)
	},
	{ timeout: timeoutMs },
)

test('CloudflareRestClient sends JSON body on PATCH', async () => {
	const originalFetch = globalThis.fetch
	let capturedRequest: Request | null = null

	globalThis.fetch = (async (input, init) => {
		capturedRequest = new Request(input, init)
		return new Response(JSON.stringify({ success: true, result: null }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}) as typeof fetch

	try {
		const client = new CloudflareRestClient({
			apiToken: 'patch-token',
			baseUrl: 'https://api.cloudflare.test',
		})
		const response = await client.rawRequest({
			method: 'PATCH',
			path: '/client/v4/zones/example-zone-id/settings/always_online',
			body: { value: 'on' },
		})

		expect(response.status).toBe(200)
		expect(capturedRequest).not.toBeNull()
		expect(capturedRequest?.method).toBe('PATCH')
		expect(capturedRequest?.headers.get('authorization')).toBe(
			'Bearer patch-token',
		)
		expect(capturedRequest?.headers.get('content-type')).toBe(
			'application/json',
		)
		expect(await capturedRequest?.text()).toBe('{"value":"on"}')
	} finally {
		globalThis.fetch = originalFetch
	}
})
