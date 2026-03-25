import { expect, test } from 'vitest'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'
import {
	bunBin,
	captureOutput,
	spawnProcess,
	stopProcess,
} from '#mcp/test-process.ts'
import {
	createGitHubRestClient,
	GitHubRestClient,
} from './github-rest-client.ts'

const workerConfig = 'packages/mock-servers/github/wrangler.jsonc'
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
	throw new Error('mock github timeout')
}

async function startGithubMock(token: string) {
	const port = await getPort({ host: '127.0.0.1' })
	const origin = `http://127.0.0.1:${port}`
	const inspectorPort = await getPort({ host: '127.0.0.1' })
	const proc = spawnProcess({
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
	})
	void captureOutput(proc.stdout)
	void captureOutput(proc.stderr)
	await waitForMock(origin)
	return {
		origin,
		token,
		async [Symbol.asyncDispose]() {
			await stopProcess(proc)
		},
	}
}

test('GitHubRestClient rawRequest reads a pull request from the mock', async () => {
	const token = 'client-test-token'
	await using mock = await startGithubMock(token)
	const client = new GitHubRestClient({
		token: mock.token,
		baseUrl: mock.origin,
	})
	const response = await client.rawRequest({
		method: 'GET',
		path: '/repos/kentcdodds/kody/pulls/42',
	})
	expect(response.status).toBe(200)
	const body = response.body as { number?: number; title?: string }
	expect(body.number).toBe(42)
	expect(body.title).toContain('GitHub REST')
})

test('createGitHubRestClient uses GITHUB_API_BASE_URL for rawRequest', async () => {
	const token = 'client-test-token-2'
	await using mock = await startGithubMock(token)
	const client = createGitHubRestClient({
		GITHUB_TOKEN: mock.token,
		GITHUB_API_BASE_URL: mock.origin,
	} as Pick<Env, 'GITHUB_TOKEN' | 'GITHUB_API_BASE_URL'>)
	const response = await client.rawRequest({
		method: 'GET',
		path: '/repos/kentcdodds/kody/pulls/42',
	})
	expect(response.status).toBe(200)
})

test('GitHubRestClient rawRequest sends JSON bodies with DELETE', async () => {
	const originalFetch = globalThis.fetch
	let capturedRequest: Request | null = null

	globalThis.fetch = (async (input, init) => {
		capturedRequest = new Request(input, init)
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}) as typeof fetch

	try {
		const client = new GitHubRestClient({
			token: 'delete-body-token',
			baseUrl: 'https://api.github.test',
		})
		const response = await client.rawRequest({
			method: 'DELETE',
			path: '/repos/kentcdodds/kody/issues/42/labels/bug',
			body: { reason: 'cleanup' },
		})

		expect(response.status).toBe(200)
		expect(capturedRequest).not.toBeNull()
		expect(capturedRequest?.method).toBe('DELETE')
		expect(capturedRequest?.headers.get('content-type')).toBe(
			'application/json',
		)
		expect(await capturedRequest?.text()).toBe('{"reason":"cleanup"}')
	} finally {
		globalThis.fetch = originalFetch
	}
})
