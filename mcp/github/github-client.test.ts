/// <reference types="bun" />
import { expect, test } from 'bun:test'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'
import {
	createGitHubRestClient,
	GitHubRestClient,
} from './github-rest-client.ts'

const workerConfig = 'mock-servers/github/wrangler.jsonc'
const bunBin = process.execPath
const projectRoot = process.cwd()
const timeoutMs = 60_000

function captureOutput(stream: ReadableStream<Uint8Array> | null) {
	let output = ''
	if (!stream) return () => output
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	void (async () => {
		try {
			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				if (value) output += decoder.decode(value)
			}
		} catch {
			// ignore
		}
	})()
	return () => output
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
	void captureOutput(proc.stdout)
	void captureOutput(proc.stderr)
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
	'GitHubRestClient talks to mock for PR, status, and reviews',
	async () => {
		const token = 'client-test-token'
		await using mock = await startGithubMock(token)
		const client = new GitHubRestClient({
			token: mock.token,
			baseUrl: mock.origin,
		})
		const pr = await client.getPullRequest('kentcdodds', 'kody', 42)
		expect(pr.title).toContain('work triage')

		const status = await client.getCombinedStatus(
			'kentcdodds',
			'kody',
			pr.head.sha,
		)
		expect(status.state).toBe('failure')

		const reviews = await client.listPullReviews('kentcdodds', 'kody', 42)
		expect(reviews.length).toBeGreaterThan(0)
	},
	{ timeout: timeoutMs },
)

test(
	'createGitHubRestClient uses GITHUB_API_BASE_URL when set',
	async () => {
		const token = 'client-test-token-2'
		await using mock = await startGithubMock(token)
		const client = createGitHubRestClient({
			GITHUB_TOKEN: mock.token,
			GITHUB_API_BASE_URL: mock.origin,
		} as Pick<Env, 'GITHUB_TOKEN' | 'GITHUB_API_BASE_URL'>)
		const search = await client.searchIssues('is:open assignee:x', 5)
		expect(search.items.length).toBeGreaterThan(0)
	},
	{ timeout: timeoutMs },
)
