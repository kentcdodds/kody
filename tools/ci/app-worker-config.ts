import { readFile, writeFile } from 'node:fs/promises'
import { parseJsonc } from './resource-utils.ts'
import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * Generate deployable Wrangler configs for the Remix/content Worker
 * (ADR 0034) from the committed base config plus the main Worker's generated
 * config.
 *
 * The app-surface Worker shares the main Worker's data plane, so resource
 * identifiers are copied from the main Worker's already-provisioned generated
 * config. Cross-script references (`script_name`, `service`) committed as
 * `kody` / `kody-runtime` / `kody-jobs` / `kody-app` are rewritten to the
 * actual worker names for preview.
 */

const defaultBaseConfigPath = 'packages/app-worker/wrangler.jsonc'
const committedAppName = 'kody-app'
const committedRuntimeName = 'kody-runtime'
const committedMainName = 'kody'
const committedJobsName = 'kody-jobs'

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

function rewriteWorkerNameReferences(
	value: unknown,
	names: {
		appWorkerName: string
		runtimeWorkerName: string
		mainWorkerName: string
		jobsWorkerName: string
	},
): void {
	if (Array.isArray(value)) {
		for (const entry of value) rewriteWorkerNameReferences(entry, names)
		return
	}
	if (!value || typeof value !== 'object') return
	const record = value as JsonRecord
	for (const key of ['script_name', 'from_script', 'service']) {
		if (record[key] === committedAppName) {
			record[key] = names.appWorkerName
		} else if (record[key] === committedRuntimeName) {
			record[key] = names.runtimeWorkerName
		} else if (record[key] === committedMainName) {
			record[key] = names.mainWorkerName
		} else if (record[key] === committedJobsName) {
			record[key] = names.jobsWorkerName
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

function copyResourceIdentifiers(input: {
	appEnv: JsonRecord
	mainEnv: JsonRecord
	envName: string
}) {
	const { appEnv, mainEnv, envName } = input
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
		{
			section: 'analytics_engine_datasets',
			key: 'binding',
			fields: ['dataset'],
		},
		{ section: 'services', key: 'binding', fields: ['service'] },
	]
	for (const { section, key, fields } of copies) {
		const appEntries = appEnv[section]
		if (!Array.isArray(appEntries)) continue
		for (const entry of appEntries) {
			const record = asRecord(entry, `app env.${envName}.${section} entry`)
			const bindingName = record[key]
			if (typeof bindingName !== 'string') {
				fail(`app env.${envName}.${section} entry is missing "${key}".`)
			}
			const mainEntry = findByKey(mainEnv[section], key, bindingName)
			if (!mainEntry) {
				fail(
					`main generated config env.${envName}.${section} has no entry for binding "${bindingName}" required by the app-surface worker.`,
				)
			}
			for (const field of fields) {
				if (mainEntry[field] !== undefined) record[field] = mainEntry[field]
			}
		}
	}

	const appQueues = appEnv.queues
	if (appQueues && typeof appQueues === 'object') {
		const appProducers = (appQueues as JsonRecord).producers
		const mainProducers =
			mainEnv.queues && typeof mainEnv.queues === 'object'
				? (mainEnv.queues as JsonRecord).producers
				: undefined
		if (Array.isArray(appProducers)) {
			for (const entry of appProducers) {
				const record = asRecord(
					entry,
					`app env.${envName}.queues.producers entry`,
				)
				const bindingName = record.binding
				if (typeof bindingName !== 'string') {
					fail(`app env.${envName}.queues.producers entry missing binding.`)
				}
				const mainEntry = findByKey(mainProducers, 'binding', bindingName)
				if (!mainEntry) {
					fail(
						`main generated config env.${envName}.queues.producers has no entry for binding "${bindingName}" required by the app-surface worker.`,
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
	const appVars =
		appEnv.vars && typeof appEnv.vars === 'object'
			? (appEnv.vars as JsonRecord)
			: {}
	appEnv.vars = { ...mainVars, ...appVars }
}

function ensureAppSurfaceService(mainEnv: JsonRecord, appWorkerName: string) {
	const services = Array.isArray(mainEnv.services) ? mainEnv.services : []
	const existing = services.find(
		(entry) =>
			entry &&
			typeof entry === 'object' &&
			(entry as JsonRecord).binding === 'APP_SURFACE',
	) as JsonRecord | undefined
	if (existing) {
		existing.service = appWorkerName
		mainEnv.services = services
		return
	}
	mainEnv.services = [
		...services,
		{ binding: 'APP_SURFACE', service: appWorkerName },
	]
}

function removeAppSurfaceFromMainEnv(mainEnv: JsonRecord) {
	if (!Array.isArray(mainEnv.services)) return
	mainEnv.services = mainEnv.services.filter(
		(entry) =>
			!(
				entry &&
				typeof entry === 'object' &&
				(entry as JsonRecord).binding === 'APP_SURFACE'
			),
	)
}

export type CliOptions = {
	envName: string
	mainConfigPath: string
	appWorkerName: string
	runtimeWorkerName: string
	mainWorkerName: string
	jobsWorkerName: string
	baseConfigPath: string
	outConfigPath: string
	outMainBootstrapConfigPath?: string
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
	const appWorkerName = options['worker-name']
	const runtimeWorkerName = options['runtime-worker-name']
	const mainWorkerName = options['main-worker-name']
	const jobsWorkerName = options['jobs-worker-name']
	const outConfigPath = options['out-config']
	if (
		!envName ||
		!mainConfigPath ||
		!appWorkerName ||
		!runtimeWorkerName ||
		!mainWorkerName ||
		!jobsWorkerName ||
		!outConfigPath
	) {
		fail(
			'Usage: node tools/ci/app-worker-config.ts generate --env <production|preview> --main-config <path> --worker-name <app worker name> --runtime-worker-name <runtime worker name> --main-worker-name <main worker name> --jobs-worker-name <jobs worker name> --out-config <path> [--base-config <path>] [--out-main-bootstrap-config <path>]',
		)
	}
	return {
		envName,
		mainConfigPath,
		appWorkerName,
		runtimeWorkerName,
		mainWorkerName,
		jobsWorkerName,
		baseConfigPath: options['base-config'] ?? defaultBaseConfigPath,
		outConfigPath,
		outMainBootstrapConfigPath: options['out-main-bootstrap-config'],
	}
}

export async function generate(options: CliOptions) {
	const names = {
		appWorkerName: options.appWorkerName,
		runtimeWorkerName: options.runtimeWorkerName,
		mainWorkerName: options.mainWorkerName,
		jobsWorkerName: options.jobsWorkerName,
	}

	const appConfig = parseJsonc<JsonRecord>(
		await readFile(options.baseConfigPath, 'utf8'),
	)
	const mainConfig = parseJsonc<JsonRecord>(
		await readFile(options.mainConfigPath, 'utf8'),
	)

	const appEnv = getEnvSection(
		appConfig,
		options.envName,
		`app config "${options.baseConfigPath}"`,
	)
	const mainEnv = getEnvSection(
		mainConfig,
		options.envName,
		`main generated config "${options.mainConfigPath}"`,
	)

	appConfig.name = options.appWorkerName
	appEnv.name = options.appWorkerName
	delete appConfig.$schema
	copyResourceIdentifiers({
		appEnv,
		mainEnv,
		envName: options.envName,
	})
	rewriteWorkerNameReferences(appConfig, names)
	appEnv.workers_dev = true
	await writeFile(
		options.outConfigPath,
		`${JSON.stringify(appConfig, null, '\t')}\n`,
	)
	console.error(`Wrote app-surface worker config: ${options.outConfigPath}`)

	ensureAppSurfaceService(mainEnv, options.appWorkerName)
	await writeFile(
		options.mainConfigPath,
		`${JSON.stringify(mainConfig, null, '\t')}\n`,
	)
	console.error(
		`Patched main worker config in place: ${options.mainConfigPath}`,
	)

	if (options.outMainBootstrapConfigPath) {
		const bootstrapConfig = parseJsonc<JsonRecord>(
			await readFile(options.outMainBootstrapConfigPath, 'utf8').catch(
				async () => JSON.stringify(mainConfig),
			),
		)
		const bootstrapEnv = getEnvSection(
			bootstrapConfig,
			options.envName,
			`main bootstrap config`,
		)
		removeAppSurfaceFromMainEnv(bootstrapEnv)
		await writeFile(
			options.outMainBootstrapConfigPath,
			`${JSON.stringify(bootstrapConfig, null, '\t')}\n`,
		)
		console.error(
			`Wrote main worker bootstrap config: ${options.outMainBootstrapConfigPath}`,
		)
	}

	console.log(`app_wrangler_config=${options.outConfigPath}`)
	if (options.outMainBootstrapConfigPath) {
		console.log(
			`main_bootstrap_wrangler_config=${options.outMainBootstrapConfigPath}`,
		)
	}
}

export async function main() {
	const [command, ...rest] = process.argv.slice(2)
	if (command !== 'generate') {
		fail('Usage: node tools/ci/app-worker-config.ts generate ...')
	}
	await generate(parseArgs(rest))
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
