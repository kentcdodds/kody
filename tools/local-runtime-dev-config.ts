import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonc } from './ci/resource-utils.ts'

type JsonRecord = Record<string, unknown>

/**
 * Builds a local-dev variant of the runtime worker config for multi-config
 * `wrangler dev`. Wrangler applies `--var` and dotenv-derived values only to
 * the primary config, registers each worker under `<name>-<env>`, and treats
 * a secondary config's `ai` binding as always-remote — so the committed
 * runtime config cannot be passed to `wrangler dev` as-is. The generated
 * config pins the dev worker names so the committed cross-script references
 * (`kody` <-> `kody-runtime`) resolve, drops the `ai` binding (optional in
 * the env schema), and injects the runtime lane's required vars from the
 * dev process environment.
 */
export async function writeLocalRuntimeDevConfig({
	runtimeConfigPath,
	envName,
	mainWorkerDevName,
	port,
}: {
	runtimeConfigPath: string
	envName: string
	mainWorkerDevName: string
	port: string | undefined
}) {
	const sourceText = await readFile(runtimeConfigPath, 'utf8')
	const config = parseJsonc<JsonRecord>(sourceText)
	const envs = config.env
	if (!envs || typeof envs !== 'object') {
		throw new Error(`${runtimeConfigPath} is missing "env".`)
	}
	const runtimeEnv = (envs as JsonRecord)[envName]
	if (!runtimeEnv || typeof runtimeEnv !== 'object') {
		throw new Error(`${runtimeConfigPath} is missing "env.${envName}".`)
	}
	const envRecord = runtimeEnv as JsonRecord

	// Pin the registered dev name to the committed worker name so the main
	// config's `service`/`script_name` references to "kody-runtime" resolve.
	envRecord.name = config.name

	// The secondary config's `ai` binding is an always-remote type in
	// miniflare and fails dev startup without a real Cloudflare session.
	delete envRecord.ai

	// Cross-script bindings back to the main worker must target the name it
	// registers under in dev (`<name>-<env>`).
	const durableObjects = envRecord.durable_objects
	if (durableObjects && typeof durableObjects === 'object') {
		const bindings = (durableObjects as JsonRecord).bindings
		if (Array.isArray(bindings)) {
			for (const binding of bindings) {
				if (!binding || typeof binding !== 'object') continue
				const record = binding as JsonRecord
				if (record.script_name === 'kody') {
					record.script_name = mainWorkerDevName
				}
			}
		}
	}

	const vars =
		envRecord.vars && typeof envRecord.vars === 'object'
			? (envRecord.vars as JsonRecord)
			: {}
	envRecord.vars = vars
	vars.WRANGLER_IS_LOCAL_DEV = 'true'
	if (port) {
		vars.APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${port}`
	} else if (process.env.APP_BASE_URL) {
		vars.APP_BASE_URL = process.env.APP_BASE_URL
	}
	for (const key of ['COOKIE_SECRET', 'SECRET_STORE_KEY']) {
		const value = process.env[key]
		if (value) vars[key] = value
	}

	// Written next to the committed config so its relative paths (entry
	// module, migrations_dir) keep resolving.
	const outputPath = path.join(
		path.dirname(runtimeConfigPath),
		'wrangler-local-dev.generated.json',
	)
	await writeFile(outputPath, `${JSON.stringify(config, null, '\t')}\n`)
	return outputPath
}
