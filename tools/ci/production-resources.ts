import { readFile } from 'node:fs/promises'
import {
	ensureCloudflareQueue,
	ensureEmailSendingEventSubscription,
	ensureR2Bucket,
	fail,
	listD1Databases,
	listKvNamespaces,
	parseJsonc,
	runWrangler,
	truncateWithSuffix,
	writeGeneratedWranglerConfig,
} from './resource-utils.ts'

type Command = 'ensure'

type CliOptions = {
	wranglerConfigPath: string
	outConfigPath: string
	dryRun: boolean
	d1Location?: string
	kvTitleOverride?: string
}

type ResolvedProductionBindings = {
	workerName: string
	d1DatabaseName: string
	d1ConfiguredId: string
	oauthKvTitle: string
	oauthKvConfiguredId: string
	bundleArtifactsKvTitle: string
	bundleArtifactsKvConfiguredId: string
	communityAssetsBucketName: string
	emailBlobsBucketName: string
	emailDeliveryQueueName: string
	emailDeliveryDeadLetterQueueName: string
}

function parseArgs(argv: Array<string>): {
	command: Command
	options: CliOptions
} {
	const command = argv[0]
	if (command !== 'ensure') {
		fail(
			'Missing or invalid command. Usage: node tools/ci/production-resources.ts ensure [--out-config <path>]',
		)
	}

	const options: CliOptions = {
		wranglerConfigPath: 'packages/worker/wrangler.jsonc',
		outConfigPath: 'packages/worker/wrangler-production.generated.json',
		dryRun: false,
		d1Location: undefined,
		kvTitleOverride: undefined,
	}

	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index]
		if (!arg) continue

		switch (arg) {
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
			case '--kv-title': {
				options.kvTitleOverride = argv[index + 1] ?? ''
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

	if (!options.wranglerConfigPath) {
		fail('Missing required flag: --wrangler-config <path>')
	}
	if (!options.outConfigPath) {
		fail('Missing required flag: --out-config <path>')
	}

	return { command, options }
}

function defaultOauthKvTitle(workerName: string) {
	return truncateWithSuffix(workerName, '-oauth', 63)
}

function defaultBundleArtifactsKvTitle(workerName: string) {
	return truncateWithSuffix(workerName, '-bundle-artifacts', 63)
}

function resolveEmailSendingDomain(dryRun: boolean) {
	const configured = process.env.USER_EMAIL_DOMAIN?.trim()
		.toLowerCase()
		.replace(/\.$/, '')
	if (configured) return configured
	const appBaseUrl = process.env.APP_BASE_URL?.trim()
	if (!appBaseUrl) {
		if (dryRun) return 'inbox.example.com'
		fail(
			'Missing APP_BASE_URL or USER_EMAIL_DOMAIN; cannot configure Email Sending event subscription.',
		)
	}
	return `inbox.${new URL(appBaseUrl).hostname.toLowerCase()}`
}

function ensureD1Database({
	name,
	configuredId,
	location,
	dryRun,
}: {
	name: string
	configuredId: string
	location?: string
	dryRun: boolean
}) {
	if (dryRun) {
		console.error(`[dry-run] ensure D1 database: ${name}`)
		return { name, id: `dry-run-${name}` }
	}

	const databases = listD1Databases()

	if (configuredId) {
		const byId = databases.find((entry) => entry.uuid === configuredId)
		if (byId) {
			console.error(`D1 database exists by id: ${byId.name} (${byId.uuid})`)
			return { name: byId.name, id: byId.uuid }
		}
	}

	const byName = databases.find((entry) => entry.name === name)
	if (byName) {
		console.error(`D1 database exists by name: ${name} (${byName.uuid})`)
		return { name: byName.name, id: byName.uuid }
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

	const created = listD1Databases().find((entry) => entry.name === name)
	if (!created) {
		fail(`Created D1 database "${name}" but could not find it via list.`)
	}

	console.error(`Created D1 database: ${name} (${created.uuid})`)
	return { name: created.name, id: created.uuid }
}

function ensureKvNamespace({
	title,
	configuredId,
	dryRun,
}: {
	title: string
	configuredId: string
	dryRun: boolean
}) {
	if (dryRun) {
		console.error(`[dry-run] ensure KV namespace: ${title}`)
		return { title, id: `dry-run-${title}` }
	}

	const namespaces = listKvNamespaces()

	if (configuredId) {
		const byId = namespaces.find((entry) => entry.id === configuredId)
		if (byId) {
			console.error(`KV namespace exists by id: ${byId.title} (${byId.id})`)
			return { title: byId.title, id: byId.id }
		}
	}

	const byTitle = namespaces.find((entry) => entry.title === title)
	if (byTitle) {
		console.error(`KV namespace exists by title: ${title} (${byTitle.id})`)
		return { title: byTitle.title, id: byTitle.id }
	}

	// If Wrangler prompts to update config, always answer "no".
	const createResult = runWrangler(['kv', 'namespace', 'create', title], {
		input: 'n\n',
		quiet: true,
	})
	if (createResult.status !== 0) {
		fail(`Failed to create KV namespace: ${title}`)
	}

	const created = listKvNamespaces().find((entry) => entry.title === title)
	if (!created) {
		fail(`Created KV namespace "${title}" but could not find it via list.`)
	}

	console.error(`Created KV namespace: ${title} (${created.id})`)
	return { title: created.title, id: created.id }
}

async function resolveProductionBindings({
	wranglerConfigPath,
	kvTitleOverride,
}: {
	wranglerConfigPath: string
	kvTitleOverride?: string
}) {
	const baseText = await readFile(wranglerConfigPath, 'utf8')
	const config = parseJsonc<Record<string, unknown>>(baseText)

	const workerName = config.name
	if (typeof workerName !== 'string' || workerName.length === 0) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing top-level "name" (worker name).`,
		)
	}

	const env = config.env
	if (!env || typeof env !== 'object') {
		fail(`wrangler config "${wranglerConfigPath}" is missing "env".`)
	}

	const productionEnv = (env as Record<string, unknown>).production
	if (!productionEnv || typeof productionEnv !== 'object') {
		fail(`wrangler config "${wranglerConfigPath}" is missing "env.production".`)
	}

	const d1Databases = (productionEnv as Record<string, unknown>).d1_databases
	if (!Array.isArray(d1Databases)) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing "env.production.d1_databases".`,
		)
	}

	const d1Entry = d1Databases.find((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'APP_DB'
	}) as Record<string, unknown> | undefined
	if (!d1Entry) {
		fail(
			`wrangler config "${wranglerConfigPath}" has no production D1 binding for "APP_DB".`,
		)
	}

	const d1DatabaseName = d1Entry.database_name
	if (typeof d1DatabaseName !== 'string' || d1DatabaseName.length === 0) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing "database_name" for production "APP_DB".`,
		)
	}
	const d1ConfiguredId =
		typeof d1Entry.database_id === 'string' ? d1Entry.database_id : ''

	const kvNamespaces = (productionEnv as Record<string, unknown>).kv_namespaces
	if (!Array.isArray(kvNamespaces)) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing "env.production.kv_namespaces".`,
		)
	}

	const oauthKvEntry = kvNamespaces.find((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'OAUTH_KV'
	}) as Record<string, unknown> | undefined
	if (!oauthKvEntry) {
		fail(
			`wrangler config "${wranglerConfigPath}" has no production KV binding for "OAUTH_KV".`,
		)
	}

	const bundleArtifactsKvEntry = kvNamespaces.find((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'BUNDLE_ARTIFACTS_KV'
	}) as Record<string, unknown> | undefined
	if (!bundleArtifactsKvEntry) {
		fail(
			`wrangler config "${wranglerConfigPath}" has no production KV binding for "BUNDLE_ARTIFACTS_KV".`,
		)
	}

	const oauthKvConfiguredId =
		typeof oauthKvEntry.id === 'string' ? oauthKvEntry.id : ''
	const oauthKvTitleFromConfig =
		typeof oauthKvEntry.title === 'string' && oauthKvEntry.title.length > 0
			? oauthKvEntry.title
			: ''
	const oauthKvTitle =
		(kvTitleOverride && kvTitleOverride.length > 0 && kvTitleOverride) ||
		oauthKvTitleFromConfig ||
		defaultOauthKvTitle(workerName)
	const bundleArtifactsKvConfiguredId =
		typeof bundleArtifactsKvEntry.id === 'string'
			? bundleArtifactsKvEntry.id
			: ''
	const bundleArtifactsKvTitleFromConfig =
		typeof bundleArtifactsKvEntry.title === 'string' &&
		bundleArtifactsKvEntry.title.length > 0
			? bundleArtifactsKvEntry.title
			: ''
	const bundleArtifactsKvTitle =
		bundleArtifactsKvTitleFromConfig ||
		defaultBundleArtifactsKvTitle(workerName)

	const r2Buckets = (productionEnv as Record<string, unknown>).r2_buckets
	if (!Array.isArray(r2Buckets)) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing "env.production.r2_buckets".`,
		)
	}

	const emailBlobsEntry = r2Buckets.find((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'EMAIL_BLOBS'
	}) as Record<string, unknown> | undefined
	if (!emailBlobsEntry) {
		fail(
			`wrangler config "${wranglerConfigPath}" has no production R2 binding for "EMAIL_BLOBS".`,
		)
	}

	const emailBlobsBucketName = emailBlobsEntry.bucket_name
	if (
		typeof emailBlobsBucketName !== 'string' ||
		emailBlobsBucketName.length === 0
	) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing "bucket_name" for production "EMAIL_BLOBS".`,
		)
	}

	const communityAssetsEntry = r2Buckets.find((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'COMMUNITY_ASSETS'
	}) as Record<string, unknown> | undefined
	if (!communityAssetsEntry) {
		fail(
			`wrangler config "${wranglerConfigPath}" has no production R2 binding for "COMMUNITY_ASSETS".`,
		)
	}
	const communityAssetsBucketName = communityAssetsEntry.bucket_name
	if (
		typeof communityAssetsBucketName !== 'string' ||
		communityAssetsBucketName.length === 0
	) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing "bucket_name" for production "COMMUNITY_ASSETS".`,
		)
	}

	const queues = (productionEnv as Record<string, unknown>).queues
	if (!queues || typeof queues !== 'object' || Array.isArray(queues)) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing "env.production.queues".`,
		)
	}
	const consumers = (queues as Record<string, unknown>).consumers
	if (!Array.isArray(consumers) || consumers.length !== 1) {
		fail(
			`wrangler config "${wranglerConfigPath}" must define one production Queue consumer.`,
		)
	}
	const consumer = consumers[0] as Record<string, unknown>
	const emailDeliveryQueueName = consumer.queue
	const emailDeliveryDeadLetterQueueName = consumer.dead_letter_queue
	if (
		typeof emailDeliveryQueueName !== 'string' ||
		!emailDeliveryQueueName ||
		typeof emailDeliveryDeadLetterQueueName !== 'string' ||
		!emailDeliveryDeadLetterQueueName
	) {
		fail(
			`wrangler config "${wranglerConfigPath}" has invalid production email Queue names.`,
		)
	}

	const resolved: ResolvedProductionBindings = {
		workerName,
		d1DatabaseName,
		d1ConfiguredId,
		oauthKvTitle,
		oauthKvConfiguredId,
		bundleArtifactsKvTitle,
		bundleArtifactsKvConfiguredId,
		communityAssetsBucketName,
		emailBlobsBucketName,
		emailDeliveryQueueName,
		emailDeliveryDeadLetterQueueName,
	}

	return resolved
}

async function ensureProductionResources(options: CliOptions) {
	const bindings = await resolveProductionBindings({
		wranglerConfigPath: options.wranglerConfigPath,
		kvTitleOverride: options.kvTitleOverride,
	})
	console.error(
		`Ensuring production resources for worker: ${bindings.workerName} (D1: ${bindings.d1DatabaseName}, OAuth KV: ${bindings.oauthKvTitle}, Bundle KV: ${bindings.bundleArtifactsKvTitle}, Community R2: ${bindings.communityAssetsBucketName}, Email R2: ${bindings.emailBlobsBucketName})`,
	)

	const d1 = ensureD1Database({
		name: bindings.d1DatabaseName,
		configuredId: bindings.d1ConfiguredId,
		location: options.d1Location,
		dryRun: options.dryRun,
	})
	const oauthKv = ensureKvNamespace({
		title: bindings.oauthKvTitle,
		configuredId: bindings.oauthKvConfiguredId,
		dryRun: options.dryRun,
	})
	const bundleArtifactsKv = ensureKvNamespace({
		title: bindings.bundleArtifactsKvTitle,
		configuredId: bindings.bundleArtifactsKvConfiguredId,
		dryRun: options.dryRun,
	})
	const emailBlobs = ensureR2Bucket({
		name: bindings.emailBlobsBucketName,
		dryRun: options.dryRun,
	})
	const communityAssets = ensureR2Bucket({
		name: bindings.communityAssetsBucketName,
		dryRun: options.dryRun,
	})
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim()
	if ((!accountId || !apiToken) && !options.dryRun) {
		fail(
			'Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN for Queue provisioning.',
		)
	}
	const emailDeliveryQueue = await ensureCloudflareQueue({
		accountId: accountId ?? 'dry-run-account',
		apiToken: apiToken ?? 'dry-run-token',
		name: bindings.emailDeliveryQueueName,
		dryRun: options.dryRun,
	})
	await ensureCloudflareQueue({
		accountId: accountId ?? 'dry-run-account',
		apiToken: apiToken ?? 'dry-run-token',
		name: bindings.emailDeliveryDeadLetterQueueName,
		dryRun: options.dryRun,
	})
	const emailSendingDomain = resolveEmailSendingDomain(options.dryRun)
	const emailEventSubscription = await ensureEmailSendingEventSubscription({
		accountId: accountId ?? 'dry-run-account',
		apiToken: apiToken ?? 'dry-run-token',
		name: truncateWithSuffix(bindings.workerName, '-email-delivery-events', 63),
		queueId: emailDeliveryQueue.id,
		domain: emailSendingDomain,
		dryRun: options.dryRun,
	})

	const generatedConfigPath = await writeGeneratedWranglerConfig({
		baseConfigPath: options.wranglerConfigPath,
		outConfigPath: options.outConfigPath,
		envName: 'production',
		workerName: bindings.workerName,
		d1DatabaseName: d1.name,
		d1DatabaseId: d1.id,
		oauthKvId: oauthKv.id,
		bundleArtifactsKvId: bundleArtifactsKv.id,
		communityAssetsBucketName: communityAssets.name,
		emailBlobsBucketName: emailBlobs.name,
		workerVars: {
			APP_BASE_URL: process.env.APP_BASE_URL,
			CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
			USER_EMAIL_DOMAIN: process.env.USER_EMAIL_DOMAIN,
		},
	})

	// Emit GitHub Actions-friendly outputs (stdout only).
	console.log(`wrangler_config=${generatedConfigPath}`)
	console.log(`d1_database_name=${d1.name}`)
	console.log(`d1_database_id=${d1.id}`)
	console.log(`oauth_kv_title=${oauthKv.title}`)
	console.log(`oauth_kv_id=${oauthKv.id}`)
	console.log(`bundle_artifacts_kv_title=${bundleArtifactsKv.title}`)
	console.log(`bundle_artifacts_kv_id=${bundleArtifactsKv.id}`)
	console.log(`community_assets_bucket_name=${communityAssets.name}`)
	console.log(`email_blobs_bucket_name=${emailBlobs.name}`)
	console.log(`email_delivery_queue_name=${emailDeliveryQueue.name}`)
	console.log(`email_event_subscription_id=${emailEventSubscription.id}`)
}

async function main() {
	const { command, options } = parseArgs(process.argv.slice(2))

	if (!process.env.CLOUDFLARE_API_TOKEN && !options.dryRun) {
		fail(
			'Missing CLOUDFLARE_API_TOKEN (required for Wrangler resource operations).',
		)
	}

	if (command === 'ensure') {
		await ensureProductionResources(options)
		return
	}
}

await main()
