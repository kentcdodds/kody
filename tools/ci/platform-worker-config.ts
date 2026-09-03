import { readFile, writeFile } from 'node:fs/promises'
import { parseJsonc } from './resource-utils.ts'
import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * Generate deployable Wrangler configs for the platform Durable Object
 * Worker (ADR 0034) from the committed base config plus the origin
 * Worker's generated config.
 *
 * The platform Worker shares the origin Worker's data plane (same D1
 * databases, KV namespaces, R2 buckets, queues), so resource identifiers
 * are copied from the origin Worker's already-provisioned generated config
 * rather than re-provisioned. Cross-script references (`script_name`,
 * `from_script`, `service`) committed as `kody` / `kody-runtime` /
 * `kody-platform` are rewritten to the actual worker names, which lets
 * preview deploys use per-PR names.
 *
 * For preview it also writes a *bootstrap* variant of this Worker with every
 * runtime-worker reference removed. Fresh preview sets have a circular
 * reference (platform binds runtime's Durable Objects and workflow, runtime
 * binds platform's Durable Objects), and the origin Worker owns no class it
 * could stand in with (ADR 0034), so the deploy order is callee-first:
 * platform (bootstrap, no runtime references) → runtime → platform (full) →
 * origin (slim entry, cross-script bindings only).
 */

const defaultBaseConfigPath = 'packages/platform-worker/wrangler.jsonc'
const committedPlatformName = 'kody-platform'
const committedRuntimeName = 'kody-runtime'
const committedMainName = 'kody'

type JsonRecord = Record<string, unknown>

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

function asRecord(value: unknown, label: string): JsonRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		fail(`${label} is not an object.`)
	}
	return value as JsonRecord
}

function getEnvSection(config: JsonRecord, envName: string, label: string) {
	const env = asRecord(config.env, `${label} "env"`)
	return asRecord(env[envName], `${label} "env.${envName}"`)
}

/**
 * Rewrite committed worker-name references (`script_name`, `from_script`,
 * `service` values) to the resolved deploy names, anywhere in the config.
 */
function rewriteWorkerNameReferences(
	value: unknown,
	names: {
		platformWorkerName: string
		runtimeWorkerName: string
		mainWorkerName: string
	},
): void {
	if (Array.isArray(value)) {
		for (const entry of value) rewriteWorkerNameReferences(entry, names)
		return
	}
	if (!value || typeof value !== 'object') return
	const record = value as JsonRecord
	for (const key of ['script_name', 'from_script', 'service']) {
		if (record[key] === committedPlatformName) {
			record[key] = names.platformWorkerName
		} else if (record[key] === committedRuntimeName) {
			record[key] = names.runtimeWorkerName
		} else if (record[key] === committedMainName) {
			record[key] = names.mainWorkerName
		}
	}
	for (const child of Object.values(record)) {
		rewriteWorkerNameReferences(child, names)
	}
}

function findByKey(
	entries: unknown,
	key: string,
	value: string,
): JsonRecord | undefined {
	if (!Array.isArray(entries)) return undefined
	return entries.find(
		(entry) =>
			entry &&
			typeof entry === 'object' &&
			(entry as JsonRecord)[key] === value,
	) as JsonRecord | undefined
}

/**
 * Copy provisioned resource identifiers from the origin Worker's generated
 * env into the platform env, matched by binding name. The platform Worker
 * binds a strict subset of the origin Worker's resources; every platform
 * binding must resolve or the deploy would target the wrong (or a
 * nonexistent) resource.
 */
function copyResourceIdentifiers(input: {
	platformEnv: JsonRecord
	mainEnv: JsonRecord
	envName: string
}) {
	const { platformEnv, mainEnv, envName } = input

	const copies: Array<{
		section: string
		key: string
		fields: Array<string>
	}> = [
		{
			section: 'd1_databases',
			key: 'binding',
			fields: ['database_name', 'database_id'],
		},
		{ section: 'kv_namespaces', key: 'binding', fields: ['id', 'title'] },
		{ section: 'r2_buckets', key: 'binding', fields: ['bucket_name'] },
		{ section: 'vectorize', key: 'binding', fields: ['index_name'] },
		{
			section: 'analytics_engine_datasets',
			key: 'binding',
			fields: ['dataset'],
		},
		{ section: 'services', key: 'binding', fields: ['service'] },
	]
	for (const { section, key, fields } of copies) {
		const platformEntries = platformEnv[section]
		if (!Array.isArray(platformEntries)) continue
		for (const entry of platformEntries) {
			const record = asRecord(entry, `platform env.${envName}.${section} entry`)
			const bindingName = record[key]
			if (typeof bindingName !== 'string') {
				fail(`platform env.${envName}.${section} entry is missing "${key}".`)
			}
			const mainEntry = findByKey(mainEnv[section], key, bindingName)
			if (!mainEntry) {
				fail(
					`main generated config env.${envName}.${section} has no entry for binding "${bindingName}" required by the platform worker.`,
				)
			}
			for (const field of fields) {
				if (mainEntry[field] !== undefined) record[field] = mainEntry[field]
			}
		}
	}

	const platformQueues = platformEnv.queues
	if (platformQueues && typeof platformQueues === 'object') {
		const platformProducers = (platformQueues as JsonRecord).producers
		const mainProducers =
			mainEnv.queues && typeof mainEnv.queues === 'object'
				? (mainEnv.queues as JsonRecord).producers
				: undefined
		if (Array.isArray(platformProducers)) {
			for (const entry of platformProducers) {
				const record = asRecord(
					entry,
					`platform env.${envName}.queues.producers entry`,
				)
				const bindingName = record.binding
				if (typeof bindingName !== 'string') {
					fail(
						`platform env.${envName}.queues.producers entry missing binding.`,
					)
				}
				const mainEntry = findByKey(mainProducers, 'binding', bindingName)
				if (!mainEntry) {
					fail(
						`main generated config env.${envName}.queues.producers has no entry for binding "${bindingName}" required by the platform worker.`,
					)
				}
				record.queue = mainEntry.queue
			}
		}
	}

	const mainVars =
		mainEnv.vars && typeof mainEnv.vars === 'object'
			? (mainEnv.vars as JsonRecord)
			: {}
	const platformVars =
		platformEnv.vars && typeof platformEnv.vars === 'object'
			? (platformEnv.vars as JsonRecord)
			: {}
	platformEnv.vars = { ...mainVars, ...platformVars }
}

/**
 * The runtime script does not exist yet when a fresh platform script first
 * deploys, so the bootstrap upload carries no binding that resolves to it.
 * Nothing calls the platform Worker in the window before its full redeploy
 * (origin deploys last), so the missing bindings are never dereferenced.
 */
function removeRuntimeReferencesFromPlatformEnv(
	platformEnv: JsonRecord,
	runtimeWorkerName: string,
) {
	const referencesRuntime = (entry: unknown) =>
		Boolean(
			entry &&
			typeof entry === 'object' &&
			(entry as JsonRecord).script_name === runtimeWorkerName,
		)
	const durableObjects = platformEnv.durable_objects
	if (durableObjects && typeof durableObjects === 'object') {
		const bindings = (durableObjects as JsonRecord).bindings
		if (Array.isArray(bindings)) {
			;(durableObjects as JsonRecord).bindings = bindings.filter(
				(entry) => !referencesRuntime(entry),
			)
		}
	}
	if (Array.isArray(platformEnv.workflows)) {
		platformEnv.workflows = platformEnv.workflows.filter(
			(entry) => !referencesRuntime(entry),
		)
	}
	if (Array.isArray(platformEnv.services)) {
		platformEnv.services = platformEnv.services.filter(
			(entry) =>
				!(
					entry &&
					typeof entry === 'object' &&
					(entry as JsonRecord).service === runtimeWorkerName
				),
		)
	}
}

function alignCrossScriptWorkflowName(
	envRecord: JsonRecord,
	runtimeWorkerName: string,
) {
	if (!Array.isArray(envRecord.workflows)) return
	if (envRecord.workflows.length > 1) {
		fail(
			`platform workflows declares ${String(envRecord.workflows.length)} entries; the generator only knows how to name the single dynamic-callable workflow. Extend the naming logic before adding workflows.`,
		)
	}
	for (const entry of envRecord.workflows) {
		if (entry && typeof entry === 'object') {
			;(entry as JsonRecord).name =
				`${runtimeWorkerName}-dynamic-callable-workflows`
		}
	}
}

export type CliOptions = {
	envName: string
	mainConfigPath: string
	platformWorkerName: string
	runtimeWorkerName: string
	mainWorkerName: string
	baseConfigPath: string
	outConfigPath: string
	outPlatformBootstrapConfigPath?: string
}

function parseArgs(argv: Array<string>): CliOptions {
	const options: Record<string, string> = {}
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index]
		const value = argv[index + 1]
		if (!flag?.startsWith('--') || value === undefined) {
			fail(`Invalid argument pair: ${flag ?? ''} ${value ?? ''}`)
		}
		options[flag.slice(2)] = value
	}
	const envName = options.env
	const mainConfigPath = options['main-config']
	const platformWorkerName = options['worker-name']
	const runtimeWorkerName = options['runtime-worker-name']
	const mainWorkerName = options['main-worker-name']
	const outConfigPath = options['out-config']
	if (
		!envName ||
		!mainConfigPath ||
		!platformWorkerName ||
		!runtimeWorkerName ||
		!mainWorkerName ||
		!outConfigPath
	) {
		fail(
			'Usage: node tools/ci/platform-worker-config.ts generate --env <production|preview> --main-config <path> --worker-name <platform worker name> --runtime-worker-name <runtime worker name> --main-worker-name <main worker name> --out-config <path> [--base-config <path>] [--out-platform-bootstrap-config <path>]',
		)
	}
	return {
		envName,
		mainConfigPath,
		platformWorkerName,
		runtimeWorkerName,
		mainWorkerName,
		baseConfigPath: options['base-config'] ?? defaultBaseConfigPath,
		outConfigPath,
		outPlatformBootstrapConfigPath: options['out-platform-bootstrap-config'],
	}
}

export async function generate(options: CliOptions) {
	const names = {
		platformWorkerName: options.platformWorkerName,
		runtimeWorkerName: options.runtimeWorkerName,
		mainWorkerName: options.mainWorkerName,
	}

	const platformConfig = parseJsonc<JsonRecord>(
		await readFile(options.baseConfigPath, 'utf8'),
	)
	const mainConfig = parseJsonc<JsonRecord>(
		await readFile(options.mainConfigPath, 'utf8'),
	)

	const platformEnv = getEnvSection(
		platformConfig,
		options.envName,
		`platform config "${options.baseConfigPath}"`,
	)
	const mainEnv = getEnvSection(
		mainConfig,
		options.envName,
		`main generated config "${options.mainConfigPath}"`,
	)

	platformConfig.name = options.platformWorkerName
	// Pin the selected env's name too. Wrangler otherwise deploys and
	// secret-bulks `--env production` as `<name>-production`, which would
	// not match the origin worker's cross-script bindings (`kody-platform`).
	platformEnv.name = options.platformWorkerName
	delete platformConfig.$schema
	copyResourceIdentifiers({
		platformEnv,
		mainEnv,
		envName: options.envName,
	})
	rewriteWorkerNameReferences(platformConfig, names)
	alignCrossScriptWorkflowName(platformEnv, options.runtimeWorkerName)
	platformEnv.workers_dev = true
	await writeFile(
		options.outConfigPath,
		`${JSON.stringify(platformConfig, null, '\t')}\n`,
	)
	console.error(`Wrote platform worker config: ${options.outConfigPath}`)

	rewriteWorkerNameReferences(mainConfig, names)
	await writeFile(
		options.mainConfigPath,
		`${JSON.stringify(mainConfig, null, '\t')}\n`,
	)
	console.error(
		`Patched main worker config in place: ${options.mainConfigPath}`,
	)

	if (options.outPlatformBootstrapConfigPath) {
		const bootstrapConfig = parseJsonc<JsonRecord>(
			JSON.stringify(platformConfig),
		)
		const bootstrapEnv = getEnvSection(
			bootstrapConfig,
			options.envName,
			`platform bootstrap config`,
		)
		removeRuntimeReferencesFromPlatformEnv(
			bootstrapEnv,
			options.runtimeWorkerName,
		)
		await writeFile(
			options.outPlatformBootstrapConfigPath,
			`${JSON.stringify(bootstrapConfig, null, '\t')}\n`,
		)
		console.error(
			`Wrote platform worker bootstrap config: ${options.outPlatformBootstrapConfigPath}`,
		)
	}

	console.log(`platform_wrangler_config=${options.outConfigPath}`)
	if (options.outPlatformBootstrapConfigPath) {
		console.log(
			`platform_bootstrap_wrangler_config=${options.outPlatformBootstrapConfigPath}`,
		)
	}
}

export async function main() {
	const [command, ...rest] = process.argv.slice(2)
	if (command !== 'generate') {
		fail('Usage: node tools/ci/platform-worker-config.ts generate ...')
	}
	await generate(parseArgs(rest))
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
