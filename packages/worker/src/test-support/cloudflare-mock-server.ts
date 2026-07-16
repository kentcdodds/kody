import { setTimeout as delay } from 'node:timers/promises'
import {
	captureOutput,
	spawnProcess,
	stopProcess,
	wranglerBin,
} from '#mcp/test-process.ts'

const workerConfig = 'packages/mock-servers/cloudflare/wrangler.jsonc'
const projectRoot = process.cwd()
const startupTimeout = 60_000

async function waitForCloudflareMock(
	proc: ReturnType<typeof spawnProcess>,
	readStdout: () => string,
	readStderr: () => string,
) {
	const deadline = Date.now() + startupTimeout
	const exited = proc.exited.then(
		(code) => ({ status: 'exited' as const, code }),
		(error: unknown) => ({ status: 'error' as const, error }),
	)
	while (Date.now() < deadline) {
		const output = `${readStdout()}\n${readStderr()}`
		const readyMatch = output.match(/\bReady on (http:\/\/127\.0\.0\.1:\d+)\b/)
		const origin = readyMatch?.[1]
		if (origin) {
			try {
				const response = await fetch(`${origin}/__mocks/meta`)
				if (response.ok) {
					await response.body?.cancel()
					return origin
				}
			} catch {
				/* retry */
			}
		}

		const exitResult = await Promise.race([exited, delay(200).then(() => null)])
		if (exitResult?.status === 'error') {
			throw new Error('mock cloudflare failed to start', {
				cause: exitResult.error,
			})
		}
		if (exitResult?.status === 'exited') {
			throw new Error(
				`mock cloudflare exited before becoming ready (code ${String(exitResult.code)})\n${output}`,
			)
		}
	}
	throw new Error(
		`mock cloudflare did not become ready within ${startupTimeout}ms\n${readStdout()}\n${readStderr()}`,
	)
}

export async function startCloudflareMock(token: string) {
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
			'0',
			'--inspector-port',
			'0',
			'--ip',
			'127.0.0.1',
			'--show-interactive-dev-session=false',
			'--log-level',
			'info',
		],
		cwd: projectRoot,
	})
	const readStdout = captureOutput(proc.stdout)
	const readStderr = captureOutput(proc.stderr)
	try {
		const origin = await waitForCloudflareMock(proc, readStdout, readStderr)
		return {
			origin,
			token,
			async [Symbol.asyncDispose]() {
				await stopProcess(proc)
			},
		}
	} catch (error) {
		await stopProcess(proc)
		throw error
	}
}
