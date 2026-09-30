import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { startCloudflareMock } from '#worker/test-support/cloudflare-mock-server.ts'
import {
	e2eCloudflareMockAccountId,
	writeE2eCloudflareMockState,
} from './e2e-cloudflare-mock-state.ts'
import { isExecutedDirectly, resolveNpmCommand } from './node-runtime.ts'
import { spawnChildProcess, stopChildProcessTree } from './dev-process-utils.ts'

/** Same default as `playwright.config.ts` when `--port` is omitted. */
export const defaultE2eWebServerPort = '3847'

export function resolveE2eWebServerHealthUrl(
	args: ReadonlyArray<string>,
	host = '127.0.0.1',
) {
	const portIndex = args.indexOf('--port')
	const portArg = portIndex === -1 ? undefined : args[portIndex + 1]
	const port =
		portArg && !portArg.startsWith('-') ? portArg : defaultE2eWebServerPort
	return `http://${host}:${port}/health`
}

/**
 * Restart Vite only while the first process has never answered `/health`.
 * After Playwright starts specs, a crash must kill this wrapper so the
 * suite-level dead-server retry can start a fresh run.
 */
export function shouldRetryE2eWebServerFirstStart(input: {
	allowRetry: boolean
	shuttingDown: boolean
	servedHealth: boolean
	exitCode: number | null
}) {
	return (
		input.allowRetry &&
		!input.shuttingDown &&
		!input.servedHealth &&
		(input.exitCode ?? 1) !== 0
	)
}

function runSetup(command: string, args: Array<string>) {
	const result = spawnSync(command, args, {
		stdio: 'inherit',
		env: process.env,
	})
	const status = result.status ?? 1
	if (status !== 0) process.exit(status)
}

async function startE2eWebServer() {
	runSetup(process.execPath, ['tools/prepare-e2e-env.ts'])
	runSetup(resolveNpmCommand(), ['run', 'migrate:e2e'])

	const mock = await startCloudflareMock(`e2e-cloudflare-${randomUUID()}`)
	try {
		await writeE2eCloudflareMockState({
			origin: mock.origin,
			token: mock.token,
			accountId: e2eCloudflareMockAccountId,
		})
	} catch (error) {
		await mock[Symbol.asyncDispose]()
		throw error
	}

	const extraArgs = process.argv.slice(2)
	const viteEnv = {
		...process.env,
		CLOUDFLARE_API_BASE_URL: mock.origin,
		CLOUDFLARE_API_TOKEN: mock.token,
		CLOUDFLARE_ACCOUNT_ID: e2eCloudflareMockAccountId,
		CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
		WRANGLER_IS_LOCAL_DEV: 'true',
		WRANGLER_PERSIST_TO: '.wrangler/state/e2e',
		X_LOCAL_EXPLORER: 'false',
	}

	function spawnVite() {
		return spawnChildProcess(
			process.execPath,
			[
				'--env-file=packages/worker/.env',
				'node_modules/vite/bin/vite.js',
				'--host',
				'127.0.0.1',
				...extraArgs,
			],
			{
				stdio: 'inherit',
				env: viteEnv,
			},
		)
	}

	let shuttingDown = false
	let servedHealth = false
	let vite = spawnVite()
	const healthUrl = resolveE2eWebServerHealthUrl(extraArgs)

	async function shutdown(exitCode: number) {
		if (shuttingDown) return
		shuttingDown = true
		await stopChildProcessTree(vite)
		await mock[Symbol.asyncDispose]()
		process.exit(exitCode)
	}

	async function watchFirstStartHealth() {
		while (!shuttingDown && !servedHealth) {
			try {
				const response = await fetch(healthUrl, {
					signal: AbortSignal.timeout(2_000),
				})
				if (response.ok) {
					servedHealth = true
					return
				}
			} catch {
				// Vite has not bound /health yet, or the first process already died.
			}
			await delay(250)
		}
	}

	function watchVite(child: ReturnType<typeof spawnVite>, allowRetry: boolean) {
		vite = child
		child.once('exit', (code) => {
			if (shuttingDown) return
			if (
				shouldRetryE2eWebServerFirstStart({
					allowRetry,
					shuttingDown,
					servedHealth,
					exitCode: code,
				})
			) {
				console.error(
					'Vite e2e webServer exited before /health; retrying once with a fresh process.',
				)
				watchVite(spawnVite(), false)
				void watchFirstStartHealth()
				return
			}
			void shutdown(code ?? 1)
		})
		child.once('error', () => {
			if (shuttingDown) return
			if (
				shouldRetryE2eWebServerFirstStart({
					allowRetry,
					shuttingDown,
					servedHealth,
					exitCode: 1,
				})
			) {
				console.error(
					'Vite e2e webServer failed to spawn before /health; retrying once with a fresh process.',
				)
				watchVite(spawnVite(), false)
				void watchFirstStartHealth()
				return
			}
			void shutdown(1)
		})
	}

	watchVite(vite, true)
	void watchFirstStartHealth()
	process.once('SIGINT', () => {
		void shutdown(0)
	})
	process.once('SIGTERM', () => {
		void shutdown(0)
	})
}

if (isExecutedDirectly(import.meta.url)) {
	void startE2eWebServer().catch((error) => {
		console.error(error instanceof Error ? error.message : error)
		process.exit(1)
	})
}
