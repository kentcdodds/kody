/// <reference types="bun" />
import { expect, test } from 'bun:test'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'
import { experimentalGithubRestCapability } from './experimental-github-rest.ts'
import { getNextWorkItemsCapability } from './get-next-work-items.ts'
import { getReviewQueueCapability } from './get-review-queue.ts'
import { summarizePrStatusCapability } from './summarize-pr-status.ts'

const workerConfig = 'mock-servers/github/wrangler.jsonc'
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

test(
	'summarize_pr_status returns structured summary from mock GitHub',
	async () => {
		const token = 'work-triage-cap-token'
		await using mock = await startGithubMock(token)
		const ctx = mockContext(mock.origin, mock.token)
		const result = await summarizePrStatusCapability.handler(
			{ owner: 'kentcdodds', repo: 'kody', pr_number: 42 },
			ctx,
		)
		expect(result.number).toBe(42)
		expect(result.combined_status_state).toBe('failure')
		expect(result.failing_contexts).toContain('types')
		expect(result.suggested_next_step).toContain('Fix failing checks')
	},
	{ timeout: timeoutMs },
)

test(
	'get_review_queue returns mock review-requested items',
	async () => {
		const token = 'work-triage-queue-token'
		await using mock = await startGithubMock(token)
		const ctx = mockContext(mock.origin, mock.token)
		const result = await getReviewQueueCapability.handler(
			{ review_requested_login: 'kentcdodds', limit: 10 },
			ctx,
		)
		expect(result.items.length).toBeGreaterThan(0)
		expect(result.items[0]?.kind).toBe('review_requested_pr')
	},
	{ timeout: timeoutMs },
)

test(
	'experimental_github_rest returns JSON from mock GitHub (experimental primitive)',
	async () => {
		const token = 'work-triage-raw-token'
		await using mock = await startGithubMock(token)
		const ctx = mockContext(mock.origin, mock.token)
		const result = await experimentalGithubRestCapability.handler(
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
	'experimental_github_rest rejects absolute URLs in path',
	async () => {
		const token = 'work-triage-raw-reject-token'
		await using mock = await startGithubMock(token)
		const ctx = mockContext(mock.origin, mock.token)
		await expect(
			experimentalGithubRestCapability.handler(
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
	'get_next_work_items merges assigned issues and review PRs',
	async () => {
		const token = 'work-triage-next-token'
		await using mock = await startGithubMock(token)
		const ctx = mockContext(mock.origin, mock.token)
		const result = await getNextWorkItemsCapability.handler(
			{
				assignee_login: 'kentcdodds',
				review_requested_login: 'kentcdodds',
				limit_per_query: 10,
				max_items: 20,
			},
			ctx,
		)
		const kinds = result.items.map((i) => i.kind)
		expect(kinds).toContain('assigned_issue')
		expect(kinds).toContain('review_requested_pr')
	},
	{ timeout: timeoutMs },
)
