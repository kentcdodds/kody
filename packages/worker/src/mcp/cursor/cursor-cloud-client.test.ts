import { expect, test } from 'vitest'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'
import {
	captureOutput,
	spawnProcess,
	stopProcess,
	wranglerBin,
} from '#mcp/test-process.ts'
import {
	CursorCloudClient,
	createCursorCloudClient,
} from './cursor-cloud-client.ts'

const workerConfig = 'packages/mock-servers/cursor/wrangler.jsonc'
const projectRoot = process.cwd()

async function waitForMock(origin: string) {
	const deadline = Date.now() + 25_000
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${origin}/__mocks/meta`)
			if (r.ok) {
				await r.body?.cancel()
				return
			}
		} catch {
			/* retry */
		}
		await delay(200)
	}
	throw new Error('mock cursor timeout')
}

async function startCursorMock(token: string) {
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

test('CursorCloudClient rawRequest uses Basic auth and reads agents from mock', async () => {
	const token = 'cursor-client-mock-token'
	await using mock = await startCursorMock(token)
	const client = new CursorCloudClient({
		apiKey: mock.token,
		baseUrl: mock.origin,
	})
	const response = await client.rawRequest({
		method: 'GET',
		path: '/v0/agents',
	})
	expect(response.status).toBe(200)
	const body = response.body as { agents?: Array<{ id?: string }> }
	expect(Array.isArray(body.agents)).toBe(true)
	expect(body.agents?.some((a) => a.id === 'bc_mock_42')).toBe(true)
})

test('createCursorCloudClient uses CURSOR_API_BASE_URL for rawRequest', async () => {
	const token = 'cursor-client-env-token'
	await using mock = await startCursorMock(token)
	const client = createCursorCloudClient({
		CURSOR_API_KEY: mock.token,
		CURSOR_API_BASE_URL: mock.origin,
	} as Pick<Env, 'CURSOR_API_KEY' | 'CURSOR_API_BASE_URL'>)
	const response = await client.rawRequest({
		method: 'GET',
		path: '/v0/me',
	})
	expect(response.status).toBe(200)
})

test('CursorCloudClient sends JSON body on POST', async () => {
	const originalFetch = globalThis.fetch
	let capturedRequest: Request | null = null

	globalThis.fetch = (async (input, init) => {
		capturedRequest = new Request(input, init)
		return new Response(JSON.stringify({ id: 'bc_test' }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}) as typeof fetch

	try {
		const client = new CursorCloudClient({
			apiKey: 'post-key',
			baseUrl: 'https://api.cursor.test',
		})
		const response = await client.rawRequest({
			method: 'POST',
			path: '/v0/agents',
			body: {
				prompt: { text: 'hello' },
				source: { repository: 'https://github.com/a/b' },
			},
		})

		expect(response.status).toBe(200)
		expect(capturedRequest).not.toBeNull()
		expect(capturedRequest?.method).toBe('POST')
		const auth = capturedRequest?.headers.get('authorization')
		expect(auth?.startsWith('Basic ')).toBe(true)
		const decoded = atob(auth!.slice('Basic '.length))
		expect(decoded.startsWith('post-key:')).toBe(true)
		expect(capturedRequest?.headers.get('content-type')).toBe(
			'application/json',
		)
	} finally {
		globalThis.fetch = originalFetch
	}
})
