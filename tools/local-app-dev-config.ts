import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonc } from './ci/resource-utils.ts'

type JsonRecord = Record<string, unknown>

/**
 * Builds a local-dev variant of the app-surface worker config for
 * multi-config `wrangler dev`. Same pitfalls as the runtime worker: wrangler
 * applies `--var` only to the primary config, registers workers under
 * `<name>-<env>`, and the committed cross-script `script_name: "kody"` refs
 * must target the primary's registered name.
 */
export async function writeLocalAppDevConfig({
	appConfigPath,
	envName,
	mainWorkerDevName,
	runtimeWorkerDevName,
	port,
}: {
	appConfigPath: string
	envName: string
	mainWorkerDevName: string
	runtimeWorkerDevName: string
	port: string | undefined
}) {
	const sourceText = await readFile(appConfigPath, 'utf8')
	const config = parseJsonc<JsonRecord>(sourceText)
	const envs = config.env
	if (!envs || typeof envs !== 'object') {
		throw new Error(`${appConfigPath} is missing "env".`)
	}
	const appEnv = (envs as JsonRecord)[envName]
	if (!appEnv || typeof appEnv !== 'object') {
		throw new Error(`${appConfigPath} is missing "env.${envName}".`)
	}
	const envRecord = appEnv as JsonRecord

	envRecord.name = config.name

	const durableObjects = envRecord.durable_objects
	if (durableObjects && typeof durableObjects === 'object') {
		const bindings = (durableObjects as JsonRecord).bindings
		if (Array.isArray(bindings)) {
			for (const binding of bindings) {
				if (!binding || typeof binding !== 'object') continue
				const record = binding as JsonRecord
				if (record.script_name === 'kody') {
					record.script_name = mainWorkerDevName
				} else if (record.script_name === 'kody-runtime') {
					record.script_name = runtimeWorkerDevName
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
		path.dirname(appConfigPath),
		'wrangler-local-dev.generated.json',
	)
	await writeFile(outputPath, `${JSON.stringify(config, null, '\t')}\n`)
	return outputPath
}
