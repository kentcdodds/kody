import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonc } from './ci/resource-utils.ts'
import { localizeMigrations } from './local-dev-migrations.ts'

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

	// Wrangler builds the local sqlite-class map from top-level migrations
	// even when `--env` is set. Put the rewritten chain there (and on the
	// env block so inherit/override both stay consistent).
	const localized = localizeMigrations(
		envRecord.migrations ?? config.migrations,
	)
	config.migrations = localized
	envRecord.migrations = localized

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

function requireRuntimeEnv(
	config: JsonRecord,
	runtimeConfigPath: string,
	envName: string,
) {
	const envs = config.env
	if (!envs || typeof envs !== 'object') {
		throw new Error(`${runtimeConfigPath} is missing "env".`)
	}
	const runtimeEnv = (envs as JsonRecord)[envName]
	if (!runtimeEnv || typeof runtimeEnv !== 'object') {
		throw new Error(`${runtimeConfigPath} is missing "env.${envName}".`)
	}
	return envs as JsonRecord
}

function localizeRuntimeConfigMigrations(config: JsonRecord, envName: string) {
	const envs = config.env as JsonRecord
	const localizedTop = localizeMigrations(config.migrations)
	config.migrations = localizedTop
	for (const [name, runtimeEnv] of Object.entries(envs)) {
		if (!runtimeEnv || typeof runtimeEnv !== 'object') continue
		const envRecord = runtimeEnv as JsonRecord
		const localized = localizeMigrations(envRecord.migrations ?? localizedTop)
		envRecord.migrations = localized
		if (name === envName) {
			config.migrations = localized
		}
	}
}

/**
 * Wrangler 4.131+ applies the local sqlite-class map during `deploy --dry-run`.
 * The committed runtime production chain transfers `PackageServiceInstance`
 * then deletes it; wrangler ignores `transferred_classes` locally, so the
 * later delete fails. Localize migrations for bundle checks only — never for
 * a real deploy. Production history stays in the committed wrangler.jsonc.
 */
export async function writeRuntimeDryRunConfig({
	runtimeConfigPath,
	envName,
}: {
	runtimeConfigPath: string
	envName: string
}) {
	const sourceText = await readFile(runtimeConfigPath, 'utf8')
	const config = parseJsonc<JsonRecord>(sourceText)
	requireRuntimeEnv(config, runtimeConfigPath, envName)
	localizeRuntimeConfigMigrations(config, envName)

	const outputPath = path.join(
		path.dirname(runtimeConfigPath),
		'wrangler-dry-run.generated.json',
	)
	await writeFile(outputPath, `${JSON.stringify(config, null, '\t')}\n`)
	return outputPath
}

/**
 * `wrangler check startup` runs an inner `deploy --dry-run` that ignores
 * `--config` and loads `wrangler.jsonc` from cwd. Write a localized snapshot
 * directory so that inner deploy does not see the production transfer-then-delete
 * chain. `main` is rewritten to an absolute path so the snapshot can live
 * outside `packages/runtime-worker`.
 */
export async function writeRuntimeStartupCheckConfig({
	runtimeConfigPath,
	envName,
	outputDir,
}: {
	runtimeConfigPath: string
	envName: string
	outputDir: string
}) {
	const sourceText = await readFile(runtimeConfigPath, 'utf8')
	const config = parseJsonc<JsonRecord>(sourceText)
	requireRuntimeEnv(config, runtimeConfigPath, envName)
	localizeRuntimeConfigMigrations(config, envName)
	if (typeof config.main === 'string') {
		config.main = path.resolve(path.dirname(runtimeConfigPath), config.main)
	}
	const outputPath = path.join(outputDir, 'wrangler.jsonc')
	await writeFile(outputPath, `${JSON.stringify(config, null, '\t')}\n`)
	return outputPath
}
