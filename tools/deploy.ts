import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { isExecutedDirectly, resolveLocalBinary } from './node-runtime.ts'
import {
	isOriginWorkerConfigPath,
	omitConfigFlag,
	readConfigFlag,
} from './origin-worker-config.ts'

function run(
	command: string,
	args: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv,
) {
	const result = spawnSync(command, [...args], {
		stdio: 'inherit',
		env,
	})
	const status = result.status ?? 1
	if (status !== 0) process.exit(status)
}

function resolveWranglerCommand() {
	const localWranglerPath = path.join(
		process.cwd(),
		'node_modules',
		'.bin',
		process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
	)
	return existsSync(localWranglerPath)
		? localWranglerPath
		: resolveLocalBinary('wrangler')
}

export const originViteWranglerConfigPath = 'dist/ssr/wrangler.json'

export function originViteDeployArgs(args: ReadonlyArray<string>) {
	return [
		'deploy',
		'--config',
		originViteWranglerConfigPath,
		...omitConfigFlag(args),
	]
}

export async function deploy(args: ReadonlyArray<string>) {
	const configPath = readConfigFlag(args)
	if (!isOriginWorkerConfigPath(configPath)) {
		run(process.execPath, ['wrangler-env.ts', 'deploy', ...args], process.env)
		return
	}

	const wranglerConfigPath = configPath ?? 'packages/worker/wrangler.jsonc'
	run(resolveLocalBinary('vite'), ['build'], {
		...process.env,
		KODY_WRANGLER_CONFIG: wranglerConfigPath,
	})
	if (!existsSync(originViteWranglerConfigPath)) {
		console.error(
			`Origin Vite build did not emit ${originViteWranglerConfigPath}; cannot deploy.`,
		)
		process.exit(1)
	}
	run(resolveWranglerCommand(), originViteDeployArgs(args), process.env)
}

if (isExecutedDirectly(import.meta.url)) {
	void deploy(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error)
		process.exit(1)
	})
}
