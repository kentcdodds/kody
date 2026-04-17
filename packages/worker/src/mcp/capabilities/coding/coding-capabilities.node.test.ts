import { expect, test } from 'vitest'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'
import {
	captureOutput,
	spawnProcess,
	stopProcess,
	wranglerBin,
} from '#mcp/test-process.ts'
import { createCloudflareRestClient } from '#mcp/cloudflare/cloudflare-rest-client.ts'

const cloudflareWorkerConfig = 'packages/mock-servers/cloudflare/wrangler.jsonc'
const projectRoot = process.cwd()

async function waitForCloudflareMock(origin: string) {
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
			cloudflareWorkerConfig,
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
	await waitForCloudflareMock(origin)
	return {
		origin,
		token,
		async [Symbol.asyncDispose]() {
			await stopProcess(proc)
		},
	}
}

function mockCloudflareContext(origin: string, token: string) {
	const env = {
		CLOUDFLARE_ACCOUNT_ID: 'cf_account_mock_123',
		CLOUDFLARE_API_TOKEN: token,
		CLOUDFLARE_API_BASE_URL: origin,
	} as Env
	return {
		env,
		callerContext: {
			baseUrl: 'http://localhost:3742',
			user: null,
		},
	}
}

// Each case spawns `wrangler dev` and waits up to 25s for /__mocks/meta. The
// shared Vitest CI timeout is 20s (vitest-shared.ts), so each test needs a
// higher limit for cold starts.
const wranglerMockTimeout = { timeout: 60_000 } as const

test(
	'createCloudflareRestClient rawRequest returns JSON from mock Cloudflare API',
	wranglerMockTimeout,
	async () => {
		const token = 'coding-cloudflare-token'
		await using mock = await startCloudflareMock(token)
		const ctx = mockCloudflareContext(mock.origin, mock.token)
		const client = createCloudflareRestClient(ctx.env)
		const result = await client.rawRequest({
			method: 'GET',
			path: '/client/v4/accounts',
		})
		expect(result.status).toBe(200)
		const body = result.body as {
			success?: boolean
			result?: Array<{ id?: string }>
		}
		expect(body.success).toBe(true)
		expect(
			body.result?.some((account) => account.id === 'cf_account_mock_123'),
		).toBe(true)
	},
)

test(
	'createCloudflareRestClient rejects paths not under /client/v4/',
	wranglerMockTimeout,
	async () => {
		const token = 'coding-cloudflare-reject-token'
		await using mock = await startCloudflareMock(token)
		const ctx = mockCloudflareContext(mock.origin, mock.token)
		const client = createCloudflareRestClient(ctx.env)
		await expect(
			client.rawRequest({
				method: 'GET',
				path: '/zones',
			}),
		).rejects.toThrow('path must start with `/client/v4/`')
	},
)
