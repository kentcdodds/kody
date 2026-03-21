/// <reference types="bun" />
import { expect, test } from 'bun:test'
import getPort from 'get-port'
import { setTimeout as delay } from 'node:timers/promises'

const workerConfig = 'packages/mock-servers/cloudflare/wrangler.jsonc'
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

async function startMockCloudflareWorker(token: string) {
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
	'cloudflare mock meta describes the service',
	async () => {
		const token = 'test-cloudflare-mock-token'
		await using server = await startMockCloudflareWorker(token)

		const metaResp = await fetch(new URL('/__mocks/meta', server.origin))
		expect(metaResp.status).toBe(200)
		const meta = (await metaResp.json()) as {
			service: string
			authorized: boolean
			basePath?: string
		}
		expect(meta.service).toBe('cloudflare')
		expect(meta.authorized).toBe(false)
		expect(meta.basePath).toBe('/client/v4')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'cloudflare mock returns accounts with bearer auth',
	async () => {
		const token = 'test-cloudflare-mock-token'
		await using server = await startMockCloudflareWorker(token)

		const response = await fetch(
			new URL('/client/v4/accounts', server.origin),
			{
				headers: { authorization: `Bearer ${token}` },
			},
		)
		expect(response.status).toBe(200)
		const body = (await response.json()) as {
			success: boolean
			result?: Array<{ id?: string }>
		}
		expect(body.success).toBe(true)
		expect(
			body.result?.some((account) => account.id === 'cf_account_mock_123'),
		).toBe(true)
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'cloudflare mock creates dns records with bearer auth',
	async () => {
		const token = 'test-cloudflare-mock-token'
		await using server = await startMockCloudflareWorker(token)

		const response = await fetch(
			new URL('/client/v4/zones/zone-123/dns_records', server.origin),
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					type: 'TXT',
					name: '_acme-challenge',
					content: 'proof',
				}),
			},
		)
		expect(response.status).toBe(200)
		const body = (await response.json()) as {
			success: boolean
			result?: { id?: string; type?: string; name?: string; content?: string }
		}
		expect(body.success).toBe(true)
		expect(body.result?.type).toBe('TXT')
		expect(body.result?.name).toBe('_acme-challenge')
		expect(body.result?.content).toBe('proof')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'cloudflare mock rejects API requests without token when configured',
	async () => {
		const token = 'test-cloudflare-mock-token'
		await using server = await startMockCloudflareWorker(token)

		const response = await fetch(new URL('/client/v4/accounts', server.origin))
		expect(response.status).toBe(401)
	},
	{ timeout: defaultTimeoutMs },
)
