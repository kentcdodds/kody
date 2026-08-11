import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
	ensureCloudflareQueue,
	fail,
	listCloudflareQueues,
	listD1Databases,
	parseJsonc,
	runWrangler,
} from './resource-utils.ts'

type EnvName = 'production' | 'preview'

type CliOptions = {
	envName: EnvName
	workerName: string
	hostWorkerName: string
	wranglerConfigPath: string
	outConfigPath: string
	dryRun: boolean
	d1Location?: string
}

function parseArgs(argv: Array<string>): CliOptions {
	const command = argv[0]
	if (command !== 'ensure') {
		fail(
			'Missing or invalid command. Usage: node tools/ci/jobs-worker-resources.ts ensure --env <production|preview> [--worker-name <name> --host-worker-name <name>] --out-config <path>',
		)
	}

	const options: CliOptions = {
		envName: 'production',
		workerName: '',
		hostWorkerName: '',
		wranglerConfigPath: 'packages/jobs-worker/wrangler.jsonc',
		outConfigPath: '',
		dryRun: false,
		d1Location: undefined,
	}

	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index]
		if (!arg) continue
		switch (arg) {
			case '--env': {
				const value = argv[index + 1] ?? ''
				if (value !== 'production' && value !== 'preview') {
					fail(`Invalid --env value: ${value}`)
				}
				options.envName = value
				index += 1
				break
			}
			case '--worker-name': {
				options.workerName = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--host-worker-name': {
				options.hostWorkerName = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--wrangler-config': {
				options.wranglerConfigPath = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--out-config': {
				options.outConfigPath = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--d1-location': {
				options.d1Location = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--dry-run': {
				options.dryRun = true
				break
			}
			default: {
				if (arg.startsWith('-')) {
					fail(`Unknown flag: ${arg}`)
				}
			}
		}
	}

	if (!options.outConfigPath) {
		fail('Missing required flag: --out-config <path>')
	}
	if (options.envName === 'preview') {
		if (!options.workerName) {
			fail('Missing required flag for preview: --worker-name <name>')
		}
		if (!options.hostWorkerName) {
			fail('Missing required flag for preview: --host-worker-name <name>')
		}
	}

	return options
}

function ensureD1Database({
	name,
	location,
	dryRun,
}: {
	name: string
	location?: string
	dryRun: boolean
}) {
	if (dryRun) {
		console.error(`[dry-run] ensure D1 database: ${name}`)
		return { name, id: `dry-run-${name}` }
	}

	const existing = listD1Databases().find((db) => db.name === name)
	if (existing) {
		console.error(`D1 database exists: ${name} (${existing.uuid})`)
		return { name, id: existing.uuid }
	}

	const args = ['d1', 'create', name]
	if (location && location.length > 0) {
		args.push('--location', location)
	}
	// If Wrangler prompts to update config, always answer "no".
	const createResult = runWrangler(args, { input: 'n\n', quiet: true })
	if (createResult.status !== 0) {
		fail(`Failed to create D1 database: ${name}`)
	}

	const created = listD1Databases().find((db) => db.name === name)
	if (!created) {
		fail(`Created D1 database "${name}" but could not find it via list.`)
	}
	console.error(`Created D1 database: ${name} (${created.uuid})`)
	return { name, id: created.uuid }
}

async function ensureJobsWorkerResources(options: CliOptions) {
	const baseConfig = parseJsonc<Record<string, unknown>>(
		readFileSync(options.wranglerConfigPath, 'utf8'),
	)
	const envs = baseConfig.env
	if (!envs || typeof envs !== 'object' || Array.isArray(envs)) {
		fail(`wrangler config "${options.wranglerConfigPath}" is missing "env".`)
	}
	const targetEnv = (envs as Record<string, unknown>)[options.envName]
	if (!targetEnv || typeof targetEnv !== 'object' || Array.isArray(targetEnv)) {
		fail(
			`wrangler config "${options.wranglerConfigPath}" is missing "env.${options.envName}".`,
		)
	}
	const envConfig = targetEnv as Record<string, unknown>

	const d1Databases = envConfig.d1_databases
	if (!Array.isArray(d1Databases) || d1Databases.length !== 1) {
		fail(
			`wrangler config "${options.wranglerConfigPath}" must define exactly one env.${options.envName} D1 database.`,
		)
	}
	const jobsDb = d1Databases[0] as Record<string, unknown>
	if (
		jobsDb.binding !== 'JOBS_DB' ||
		typeof jobsDb.database_name !== 'string'
	) {
		fail(
			`wrangler config "${options.wranglerConfigPath}" env.${options.envName} must bind JOBS_DB with a database_name.`,
		)
	}

	const d1 = ensureD1Database({
		name: jobsDb.database_name,
		location: options.d1Location,
		dryRun: options.dryRun,
	})
	jobsDb.database_id = d1.id

	if (options.envName === 'production') {
		const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
		const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim()
		if ((!accountId || !apiToken) && !options.dryRun) {
			fail(
				'Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN for Queue provisioning.',
			)
		}
		const queueClient = {
			accountId: accountId ?? 'dry-run-account',
			apiToken: apiToken ?? 'dry-run-token',
			dryRun: options.dryRun,
		}
		const queues = envConfig.queues as Record<string, unknown> | undefined
		const consumers = queues?.consumers
		if (!Array.isArray(consumers) || consumers.length !== 1) {
			fail(
				`wrangler config "${options.wranglerConfigPath}" must define exactly one env.production Queue consumer.`,
			)
		}
		const consumer = consumers[0] as Record<string, unknown>
		const queueName = consumer.queue
		const deadLetterQueueName = consumer.dead_letter_queue
		if (
			typeof queueName !== 'string' ||
			typeof deadLetterQueueName !== 'string'
		) {
			fail(
				`wrangler config "${options.wranglerConfigPath}" production consumer must define queue and dead_letter_queue.`,
			)
		}
		const existingQueues = options.dryRun
			? []
			: await listCloudflareQueues(queueClient)
		await ensureCloudflareQueue({
			...queueClient,
			name: queueName,
			existingQueues,
		})
		await ensureCloudflareQueue({
			...queueClient,
			name: deadLetterQueueName,
			existingQueues,
		})
		console.log(`scheduled_dispatch_queue_name=${queueName}`)
		console.log(
			`scheduled_dispatch_dead_letter_queue_name=${deadLetterQueueName}`,
		)
	}

	let workerName = baseConfig.name as string
	if (options.envName === 'preview') {
		// Per-preview jobs workers are brand new scripts: they cannot run the
		// production script-transfer migration (from_script "kody-production"),
		// so the
		// generated preview config creates the class fresh instead.
		workerName = options.workerName
		baseConfig.name = workerName
		baseConfig.migrations = [
			{
				tag: 'v1',
				new_sqlite_classes: ['JobManager'],
			},
		]
		const services = envConfig.services
		if (!Array.isArray(services)) {
			fail(
				`wrangler config "${options.wranglerConfigPath}" is missing "env.preview.services".`,
			)
		}
		const host = services.find(
			(entry) =>
				entry &&
				typeof entry === 'object' &&
				!Array.isArray(entry) &&
				(entry as Record<string, unknown>).binding === 'HOST',
		) as Record<string, unknown> | undefined
		if (!host) {
			fail(
				`wrangler config "${options.wranglerConfigPath}" has no env.preview HOST service binding.`,
			)
		}
		host.service = options.hostWorkerName
	}

	mkdirSync(path.dirname(options.outConfigPath), { recursive: true })
	writeFileSync(
		options.outConfigPath,
		`${JSON.stringify(baseConfig, null, '\t')}\n`,
	)

	if (options.envName === 'preview') {
		// Service bindings cannot reference scripts that do not exist yet, and
		// per-preview app/jobs workers reference each other. The bootstrap
		// config omits the HOST binding so the jobs worker can deploy before
		// the app worker; the full config is deployed again afterwards.
		const bootstrapConfig = JSON.parse(JSON.stringify(baseConfig)) as Record<
			string,
			unknown
		>
		const bootstrapEnvs = bootstrapConfig.env as Record<string, unknown>
		const bootstrapEnv = bootstrapEnvs[options.envName] as Record<
			string,
			unknown
		>
		delete bootstrapEnv.services
		const bootstrapConfigPath = options.outConfigPath.replace(
			/\.json$/,
			'-bootstrap.json',
		)
		writeFileSync(
			bootstrapConfigPath,
			`${JSON.stringify(bootstrapConfig, null, '\t')}\n`,
		)
		console.log(`jobs_wrangler_bootstrap_config=${bootstrapConfigPath}`)
	}

	// Emit GitHub Actions-friendly outputs (stdout only).
	console.log(`jobs_wrangler_config=${options.outConfigPath}`)
	console.log(`jobs_worker_name=${workerName}`)
	console.log(`jobs_d1_database_name=${d1.name}`)
	console.log(`jobs_d1_database_id=${d1.id}`)
}

async function main() {
	const options = parseArgs(process.argv.slice(2))

	if (!process.env.CLOUDFLARE_API_TOKEN && !options.dryRun) {
		fail(
			'Missing CLOUDFLARE_API_TOKEN (required for Wrangler resource operations).',
		)
	}

	await ensureJobsWorkerResources(options)
}

await main()
