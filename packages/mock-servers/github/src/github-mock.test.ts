/// <reference types="bun" />
import { expect, test } from 'bun:test'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'

const workerConfig = 'packages/mock-servers/github/wrangler.jsonc'
const bunBin = process.execPath
const projectRoot = process.cwd()
const defaultTimeoutMs = 60_000

function captureOutput(stream: ReadableStream<Uint8Array> | null) {
	let output = ''
	if (!stream) {
		return () => output
	}

	const reader = stream.getReader()
	const decoder = new TextDecoder()

	const read = async () => {
		try {
			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				if (value) {
					output += decoder.decode(value)
				}
			}
		} catch {
			// Ignore stream errors while capturing output.
		}
	}

	void read()
	return () => output
}

function formatOutput(stdout: string, stderr: string) {
	const snippets: Array<string> = []
	if (stdout.trim()) {
		snippets.push(`stdout: ${stdout.trim().slice(-2000)}`)
	}
	if (stderr.trim()) {
		snippets.push(`stderr: ${stderr.trim().slice(-2000)}`)
	}
	return snippets.length > 0 ? ` Output:\n${snippets.join('\n')}` : ''
}

async function waitForMockServer(
	origin: string,
	proc: ReturnType<typeof Bun.spawn>,
	getStdout: () => string,
	getStderr: () => string,
) {
	let exited = false
	let exitCode: number | null = null
	void proc.exited
		.then((code) => {
			exited = true
			exitCode = code
		})
		.catch(() => {
			exited = true
		})

	const metaUrl = new URL('/__mocks/meta', origin)
	const deadline = Date.now() + 25_000
	while (Date.now() < deadline) {
		if (exited) {
			throw new Error(
				`wrangler dev exited (${exitCode ?? 'unknown'}).${formatOutput(
					getStdout(),
					getStderr(),
				)}`,
			)
		}
		try {
			const response = await fetch(metaUrl)
			if (response.ok) {
				await response.body?.cancel()
				return
			}
		} catch {
			// Retry until the server is ready.
		}
		await delay(250)
	}

	throw new Error(
		`Timed out waiting for mock server at ${origin}.${formatOutput(
			getStdout(),
			getStderr(),
		)}`,
	)
}

async function stopProcess(proc: ReturnType<typeof Bun.spawn>) {
	let exited = false
	void proc.exited.then(() => {
		exited = true
	})
	proc.kill('SIGINT')
	await Promise.race([proc.exited, delay(5_000)])
	if (!exited) {
		proc.kill('SIGKILL')
		await proc.exited
	}
}

async function startMockGithubWorker(token: string) {
	const port = await getPort({ host: '127.0.0.1' })
	const inspectorPortBase =
		port + 10_000 <= 65_535 ? port + 10_000 : Math.max(1, port - 10_000)
	const inspectorPort = await getPort({
		host: '127.0.0.1',
		port: Array.from(
			{ length: 10 },
			(_, index) => inspectorPortBase + index,
		).filter((candidate) => candidate > 0 && candidate <= 65_535),
	})
	const origin = `http://127.0.0.1:${port}`
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
		env: {
			...process.env,
		},
	})

	const getStdout = captureOutput(proc.stdout)
	const getStderr = captureOutput(proc.stderr)

	await waitForMockServer(origin, proc, getStdout, getStderr)

	return {
		origin,
		token,
		[Symbol.asyncDispose]: async () => {
			await stopProcess(proc)
		},
	}
}

test(
	'github mock meta describes the service',
	async () => {
		const token = 'test-github-mock-token'
		await using server = await startMockGithubWorker(token)

		const metaResp = await fetch(new URL('/__mocks/meta', server.origin))
		expect(metaResp.status).toBe(200)
		const meta = (await metaResp.json()) as {
			service: string
			authorized: boolean
			fixturePullNumber?: number
			supportsGraphql?: boolean
		}
		expect(meta.service).toBe('github')
		expect(meta.authorized).toBe(false)
		expect(meta.fixturePullNumber).toBe(42)
		expect(meta.supportsGraphql).toBe(true)
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'github mock returns fixture PR with auth',
	async () => {
		const token = 'test-github-mock-token'
		await using server = await startMockGithubWorker(token)

		const url = new URL('/repos/kentcdodds/kody/pulls/42', server.origin)
		const prResp = await fetch(url, {
			headers: { authorization: `Bearer ${token}` },
		})
		expect(prResp.status).toBe(200)
		const pr = (await prResp.json()) as { number: number; title: string }
		expect(pr.number).toBe(42)
		expect(pr.title).toContain('GitHub REST')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'github mock returns GraphQL data with auth',
	async () => {
		const token = 'test-github-mock-token'
		await using server = await startMockGithubWorker(token)

		const query = `query RepoPull($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
    }
  }
}`
		const response = await fetch(new URL('/graphql', server.origin), {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				query,
				variables: { owner: 'kentcdodds', name: 'kody', number: 42 },
			}),
		})
		expect(response.status).toBe(200)
		const body = (await response.json()) as {
			data?: { repository?: { pullRequest?: { number?: number } } }
		}
		expect(body.data?.repository?.pullRequest?.number).toBe(42)
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'github mock rejects API requests without token when configured',
	async () => {
		const token = 'test-github-mock-token'
		await using server = await startMockGithubWorker(token)

		const url = new URL('/repos/kentcdodds/kody/pulls/42', server.origin)
		const prResp = await fetch(url)
		expect(prResp.status).toBe(401)
	},
	{ timeout: defaultTimeoutMs },
)
