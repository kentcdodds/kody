/// <reference types="bun" />
import { expect, test } from 'bun:test'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'
import { cloudflareRestCapability } from './cloudflare-rest.ts'
import { cursorCloudRestCapability } from './cursor-cloud-rest.ts'
import { githubGraphqlCapability } from './github-graphql.ts'
import { githubRestCapability } from './github-rest.ts'

const workerConfig = 'packages/mock-servers/github/wrangler.jsonc'
const cloudflareWorkerConfig = 'packages/mock-servers/cloudflare/wrangler.jsonc'
const cursorWorkerConfig = 'packages/mock-servers/cursor/wrangler.jsonc'
const bunBin = process.execPath
const projectRoot = process.cwd()
const timeoutMs = 60_000
const graphqlQuery = `query RepoPull($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
    }
  }
}`

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

async function waitForCursorMock(origin: string) {
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

async function startGithubMock(token: string) {
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
		stdout: 'pipe',
		stderr: 'pipe',
	})
	captureOutput(proc.stdout)
	captureOutput(proc.stderr)
	await waitForCloudflareMock(origin)
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

async function startCursorMock(token: string) {
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
			cursorWorkerConfig,
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
	await waitForCursorMock(origin)
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

function mockContext(origin: string, token: string) {
	const env = {
		GITHUB_TOKEN: token,
		GITHUB_API_BASE_URL: origin,
	} as Env
	return {
		env,
		callerContext: {
			baseUrl: 'http://localhost:3742',
			user: null,
		},
	}
}

function mockCursorContext(origin: string, token: string) {
	const env = {
		CURSOR_API_KEY: token,
		CURSOR_API_BASE_URL: origin,
	} as Env
	return {
		env,
		callerContext: {
			baseUrl: 'http://localhost:3742',
			user: null,
		},
	}
}

function mockCloudflareContext(origin: string, token: string) {
	const env = {
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

test(
	'github_rest returns JSON from mock GitHub',
	async () => {
		const token = 'coding-raw-token'
		await using mock = await startGithubMock(token)
		const ctx = mockContext(mock.origin, mock.token)
		const result = await githubRestCapability.handler(
			{
				method: 'GET',
				path: '/repos/kentcdodds/kody/pulls/42',
			},
			ctx,
		)
		expect(result.status).toBe(200)
		const body = result.body as { number?: number; title?: string }
		expect(body.number).toBe(42)
		expect(typeof body.title).toBe('string')
	},
	{ timeout: timeoutMs },
)

test(
	'github_graphql returns data from mock GitHub',
	async () => {
		const token = 'coding-graphql-token'
		await using mock = await startGithubMock(token)
		const ctx = mockContext(mock.origin, mock.token)
		const result = await githubGraphqlCapability.handler(
			{
				query: graphqlQuery,
				variables: { owner: 'kentcdodds', name: 'kody', number: 42 },
			},
			ctx,
		)
		expect(result.status).toBe(200)
		const data = result.data as {
			repository?: { pullRequest?: { number?: number } }
		}
		expect(data.repository?.pullRequest?.number).toBe(42)
	},
	{ timeout: timeoutMs },
)

test(
	'github_graphql rejects empty query',
	async () => {
		const token = 'coding-graphql-reject-token'
		await using mock = await startGithubMock(token)
		const ctx = mockContext(mock.origin, mock.token)
		await expect(
			githubGraphqlCapability.handler(
				{
					query: '',
				},
				ctx,
			),
		).rejects.toThrow('expected string to have >=1 characters')
	},
	{ timeout: timeoutMs },
)

test(
	'github_rest rejects absolute URLs in path',
	async () => {
		const token = 'coding-raw-reject-token'
		await using mock = await startGithubMock(token)
		const ctx = mockContext(mock.origin, mock.token)
		await expect(
			githubRestCapability.handler(
				{
					method: 'GET',
					path: 'https://evil.example/api',
				},
				ctx,
			),
		).rejects.toThrow('path must start with `/`')
	},
	{ timeout: timeoutMs },
)

test(
	'cloudflare_rest returns JSON from mock Cloudflare API',
	async () => {
		const token = 'coding-cloudflare-token'
		await using mock = await startCloudflareMock(token)
		const ctx = mockCloudflareContext(mock.origin, mock.token)
		const result = await cloudflareRestCapability.handler(
			{
				method: 'GET',
				path: '/client/v4/accounts',
			},
			ctx,
		)
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
	{ timeout: timeoutMs },
)

test(
	'cloudflare_rest rejects paths not under /client/v4/',
	async () => {
		const token = 'coding-cloudflare-reject-token'
		await using mock = await startCloudflareMock(token)
		const ctx = mockCloudflareContext(mock.origin, mock.token)
		await expect(
			cloudflareRestCapability.handler(
				{
					method: 'GET',
					path: '/zones',
				},
				ctx,
			),
		).rejects.toThrow('path must start with `/client/v4/`')
	},
	{ timeout: timeoutMs },
)

test(
	'cursor_cloud_rest returns JSON from mock Cursor API',
	async () => {
		const token = 'coding-cursor-token'
		await using mock = await startCursorMock(token)
		const ctx = mockCursorContext(mock.origin, mock.token)
		const result = await cursorCloudRestCapability.handler(
			{
				method: 'GET',
				path: '/v0/agents',
			},
			ctx,
		)
		expect(result.status).toBe(200)
		const body = result.body as { agents?: Array<{ id?: string }> }
		expect(body.agents?.some((a) => a.id === 'bc_mock_42')).toBe(true)
	},
	{ timeout: timeoutMs },
)

test(
	'cursor_cloud_rest rejects paths not under /v0/',
	async () => {
		const token = 'coding-cursor-reject-token'
		await using mock = await startCursorMock(token)
		const ctx = mockCursorContext(mock.origin, mock.token)
		await expect(
			cursorCloudRestCapability.handler(
				{
					method: 'GET',
					path: '/v1/agents',
				},
				ctx,
			),
		).rejects.toThrow('path must start with `/v0/`')
	},
	{ timeout: timeoutMs },
)
