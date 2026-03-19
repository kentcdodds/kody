/// <reference types="bun" />
import { expect, test } from 'bun:test'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'
import { cursorCloudRestCapability } from './cursor-cloud-rest.ts'
import { githubRestCapability } from './github-rest.ts'

const workerConfig = 'mock-servers/github/wrangler.jsonc'
const cursorWorkerConfig = 'mock-servers/cursor/wrangler.jsonc'
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
