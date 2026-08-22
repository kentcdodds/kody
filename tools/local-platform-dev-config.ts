import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonc } from './ci/resource-utils.ts'

type JsonRecord = Record<string, unknown>

/**
 * Builds a local-dev variant of the platform worker config for multi-config
 * `wrangler dev`. Wrangler applies `--var` and dotenv-derived values only to
 * the primary config, registers each worker under `<name>-<env>`, and treats
 * a secondary config's `ai` binding as always-remote — so the committed
 * platform config cannot be passed to `wrangler dev` as-is. The generated
 * config pins the dev worker name to `kody-platform` so the origin config's
 * cross-script references resolve, drops the `ai` binding (optional in the
 * env schema), and injects required vars from the dev process environment.
 */
export async function writeLocalPlatformDevConfig({
	platformConfigPath,
	envName,
	mainWorkerDevName,
	port,
}: {
	platformConfigPath: string
	envName: string
	mainWorkerDevName: string
	port: string | undefined
}) {
	const sourceText = await readFile(platformConfigPath, 'utf8')
	const config = parseJsonc<JsonRecord>(sourceText)
	const envs = config.env
	if (!envs || typeof envs !== 'object') {
		throw new Error(`${platformConfigPath} is missing "env".`)
	}
	const platformEnv = (envs as JsonRecord)[envName]
	if (!platformEnv || typeof platformEnv !== 'object') {
		throw new Error(`${platformConfigPath} is missing "env.${envName}".`)
	}
	const envRecord = platformEnv as JsonRecord

	// Pin the registered dev name to the committed worker name so the origin
	// and runtime configs' `script_name` references to "kody-platform"
	// resolve.
	envRecord.name = config.name

	// The secondary config's `ai` binding is an always-remote type in
	// miniflare and fails dev startup without a real Cloudflare session.
	delete envRecord.ai

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

	const outputPath = path.join(
		path.dirname(platformConfigPath),
		'wrangler-local-dev.generated.json',
	)
	await writeFile(outputPath, `${JSON.stringify(config, null, '\t')}\n`)
	return outputPath
}
