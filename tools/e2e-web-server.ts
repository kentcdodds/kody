import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { startCloudflareMock } from '#worker/test-support/cloudflare-mock-server.ts'
import {
	e2eCloudflareMockAccountId,
	writeE2eCloudflareMockState,
} from './e2e-cloudflare-mock-state.ts'
import { isExecutedDirectly, resolveNpmCommand } from './node-runtime.ts'
import { spawnChildProcess, stopChildProcessTree } from './dev-process-utils.ts'

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
	const wrangler = spawnChildProcess(
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
			env: {
				...process.env,
				CLOUDFLARE_API_BASE_URL: mock.origin,
				CLOUDFLARE_API_TOKEN: mock.token,
				CLOUDFLARE_ACCOUNT_ID: e2eCloudflareMockAccountId,
				CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
				WRANGLER_IS_LOCAL_DEV: 'true',
				WRANGLER_PERSIST_TO: '.wrangler/state/e2e',
				X_LOCAL_EXPLORER: 'false',
			},
		},
	)

	let shuttingDown = false
	async function shutdown(exitCode: number) {
		if (shuttingDown) return
		shuttingDown = true
		await stopChildProcessTree(wrangler)
		await mock[Symbol.asyncDispose]()
		process.exit(exitCode)
	}

	wrangler.once('exit', (code) => {
		void shutdown(code ?? 1)
	})
	wrangler.once('error', () => {
		void shutdown(1)
	})
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
