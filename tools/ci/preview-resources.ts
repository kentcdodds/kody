import { readdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { defaultProductionEntryPath } from '../check-origin-production-exports.ts'
import { isExecutedDirectly } from '../node-runtime.ts'
import {
	inspectOriginProductionScriptState,
	planOriginPreviewDeploy,
	previewFleetScriptNames,
	stripOriginDurableObjectMigrations,
	type OriginProductionScriptState,
} from './origin-production-deploy-state.ts'
import {
	CloudflareResourceError,
	deleteCloudflareQueue,
	deleteR2Bucket,
	deleteWorkerScript,
	ensureCloudflareQueue,
	ensureR2Bucket,
	fail,
	listD1Databases,
	listCloudflareQueues,
	listKvNamespaces,
	parseJsonc,
	removeCloudflareQueueConsumers,
	runWrangler,
	runWranglerWithRetry,
	truncateWithSuffix,
	writeGeneratedWranglerConfig,
} from './resource-utils.ts'

type Command = 'ensure' | 'cleanup'

export type PreviewResourceKind = 'worker' | 'd1' | 'kv' | 'r2' | 'queue'

/**
 * Every preview resource name derives from the worker name the preview
 * workflow resolves (`kody-pr-<number>` for pull requests, `kody-branch-<slug>`
 * for manual branch previews) plus a lowercase kebab suffix: `-runtime`,
 * `-platform`, `-jobs`, `-highlight`, `-mock-<service>`, `-db`, `-audit-db`,
 * `-oauth-kv`, `-bundle-artifacts-kv`, `-community-assets`, `-email-blobs`,
 * `-repo-session-blobs`, `-webhook-dispatch`, `-webhook-dispatch-dlq`
 * (`truncateWithSuffix` may shorten the base but keeps this shape). Production
 * names (`kody`, `kody-platform`, `kody-runtime`, `kody-jobs`, `kody-audit`,
 * `kody-oauth`, `kody-webhook-dispatch`, ...) and the shared preview-env names
 * (`kody-preview*`, including `kody-preview-jobs`) never carry a `-pr-<number>`
 * or `-branch-<slug>` segment.
 */
export const previewResourceNamePattern =
	/^kody-(?:pr-\d+|branch-[a-z0-9]+)(?:-[a-z0-9]+)*$/

/**
 * Hard guard for every destructive operation in this script. Cleanup runs
 * automatically when a PR closes, so a bug or a mis-set env var (for example
 * an empty PR number) must never be able to compute a production resource
 * name and delete it. Call this immediately before each delete.
 */
export function assertPreviewResourceName(
	name: string,
	kind: PreviewResourceKind,
) {
	if (!previewResourceNamePattern.test(name)) {
		throw new Error(
			`Refusing to delete ${kind} "${name}": it does not match the preview resource naming scheme ${String(previewResourceNamePattern)}. Preview cleanup only deletes kody-pr-<number>* and kody-branch-<slug>* resources.`,
		)
	}
}

/** Default wall-clock budget for Cloudflare cleanup inside the 4-minute job. */
export const previewCleanupBudgetMsDefault = 150_000

type CliOptions = {
	workerName: string
	wranglerConfigPath: string
	outConfigPath: string
	dryRun: boolean
	d1Location?: string
}

function parseArgs(argv: Array<string>): {
	command: Command
	options: CliOptions
} {
	const command = argv[0]
	if (command !== 'ensure' && command !== 'cleanup') {
		fail(
			`Missing or invalid command. Usage: node tools/ci/preview-resources.ts <ensure|cleanup> --worker-name <name>`,
		)
	}

	const options: CliOptions = {
		workerName: '',
		wranglerConfigPath: 'packages/worker/wrangler.jsonc',
		outConfigPath: 'packages/worker/wrangler-preview.generated.json',
		dryRun: false,
		d1Location: undefined,
	}

	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index]
		if (!arg) continue
		switch (arg) {
			case '--worker-name': {
				options.workerName = argv[index + 1] ?? ''
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

	if (!options.workerName) {
		fail('Missing required flag: --worker-name <name>')
	}

	if (command === 'ensure' && !options.outConfigPath) {
		fail('Missing required flag: --out-config <path>')
	}

	return { command, options }
}

export function buildPreviewResourceNames(workerName: string) {
	const maxLen = 63
	const d1Suffix = '-db'
	const auditD1Suffix = '-audit-db'
	const oauthKvSuffix = '-oauth-kv'
	const bundleKvSuffix = '-bundle-artifacts-kv'
	const communityAssetsSuffix = '-community-assets'
	const emailBlobsSuffix = '-email-blobs'
	const repoSessionBlobsSuffix = '-repo-session-blobs'
	const webhookDispatchQueueSuffix = '-webhook-dispatch'
	const webhookDispatchDeadLetterQueueSuffix = '-webhook-dispatch-dlq'

	const d1DatabaseName = truncateWithSuffix(workerName, d1Suffix, maxLen)
	const auditD1DatabaseName = truncateWithSuffix(
		workerName,
		auditD1Suffix,
		maxLen,
	)
	const oauthKvTitle = truncateWithSuffix(workerName, oauthKvSuffix, maxLen)
	const bundleArtifactsKvTitle = truncateWithSuffix(
		workerName,
		bundleKvSuffix,
		maxLen,
	)
	const emailBlobsBucketName = truncateWithSuffix(
		workerName,
		emailBlobsSuffix,
		maxLen,
	)
	const repoSessionBlobsBucketName = truncateWithSuffix(
		workerName,
		repoSessionBlobsSuffix,
		maxLen,
	)
	const communityAssetsBucketName = truncateWithSuffix(
		workerName,
		communityAssetsSuffix,
		maxLen,
	)
	const webhookDispatchQueueName = truncateWithSuffix(
		workerName,
		webhookDispatchQueueSuffix,
		maxLen,
	)
	const webhookDispatchDeadLetterQueueName = truncateWithSuffix(
		workerName,
		webhookDispatchDeadLetterQueueSuffix,
		maxLen,
	)

	return {
		d1DatabaseName,
		auditD1DatabaseName,
		oauthKvTitle,
		bundleArtifactsKvTitle,
		communityAssetsBucketName,
		emailBlobsBucketName,
		repoSessionBlobsBucketName,
		webhookDispatchQueueName,
		webhookDispatchDeadLetterQueueName,
	}
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

export async function deletePreviewD1Database({
	name,
	dryRun,
	sleep,
	maxAttempts,
	deadlineMs,
	now,
}: {
	name: string
	dryRun: boolean
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	deadlineMs?: number
	now?: () => number
}) {
	assertPreviewResourceName(name, 'd1')
	if (dryRun) {
		console.error(`[dry-run] delete D1 database: ${name}`)
		return
	}

	const existing = listD1Databases().some((db) => db.name === name)
	if (!existing) {
		console.error(`D1 database already deleted: ${name}`)
		return
	}

	const result = await runWranglerWithRetry(
		['d1', 'delete', name, '--skip-confirmation'],
		{ quiet: true, sleep, maxAttempts, deadlineMs, now },
	)
	if (result.status !== 0) {
		const output =
			`${result.stdout}${result.stderr} ${result.errorMessage}`.trim()
		throw new CloudflareResourceError(
			'd1',
			name,
			`Failed to delete D1 database: ${name}${output ? `: ${output}` : ''}`,
		)
	}
	console.error(`Deleted D1 database: ${name}`)
}

function ensureKvNamespace({
	title,
	dryRun,
}: {
	title: string
	dryRun: boolean
}) {
	if (dryRun) {
		console.error(`[dry-run] ensure KV namespace: ${title}`)
		return { title, id: `dry-run-${title}` }
	}

	const existing = listKvNamespaces().find((ns) => ns.title === title)
	if (existing) {
		console.error(`KV namespace exists: ${title} (${existing.id})`)
		return { title, id: existing.id }
	}

	// If Wrangler prompts to update config, always answer "no".
	const createResult = runWrangler(['kv', 'namespace', 'create', title], {
		input: 'n\n',
		quiet: true,
	})
	if (createResult.status !== 0) {
		fail(`Failed to create KV namespace: ${title}`)
	}

	const created = listKvNamespaces().find((ns) => ns.title === title)
	if (!created) {
		fail(`Created KV namespace "${title}" but could not find it via list.`)
	}
	console.error(`Created KV namespace: ${title} (${created.id})`)
	return { title, id: created.id }
}

export async function deletePreviewKvNamespace({
	title,
	dryRun,
	sleep,
	maxAttempts,
	deadlineMs,
	now,
}: {
	title: string
	dryRun: boolean
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	deadlineMs?: number
	now?: () => number
}) {
	assertPreviewResourceName(title, 'kv')
	if (dryRun) {
		console.error(`[dry-run] delete KV namespace: ${title}`)
		return
	}

	const existing = listKvNamespaces().find((ns) => ns.title === title)
	if (!existing) {
		console.error(`KV namespace already deleted: ${title}`)
		return
	}

	const result = await runWranglerWithRetry(
		[
			'kv',
			'namespace',
			'delete',
			'--namespace-id',
			existing.id,
			'--skip-confirmation',
		],
		{ quiet: true, sleep, maxAttempts, deadlineMs, now },
	)
	if (result.status !== 0) {
		const output =
			`${result.stdout}${result.stderr} ${result.errorMessage}`.trim()
		throw new CloudflareResourceError(
			'kv',
			title,
			`Failed to delete KV namespace: ${title}${output ? `: ${output}` : ''}`,
		)
	}
	console.error(`Deleted KV namespace: ${title} (${existing.id})`)
}

export async function deletePreviewWorkerScript({
	name,
	dryRun,
	sleep,
	maxAttempts,
	deadlineMs,
	now,
}: {
	name: string
	dryRun: boolean
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	deadlineMs?: number
	now?: () => number
}) {
	assertPreviewResourceName(name, 'worker')
	await deleteWorkerScript({
		name,
		dryRun,
		sleep,
		maxAttempts,
		deadlineMs,
		now,
	})
}

export async function deletePreviewR2Bucket({
	name,
	dryRun,
	accountId,
	apiToken,
	fetcher,
	sleep,
	maxAttempts,
	deadlineMs,
	now,
}: {
	name: string
	dryRun: boolean
	accountId?: string
	apiToken?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	maxAttempts?: number
	deadlineMs?: number
	now?: () => number
}) {
	assertPreviewResourceName(name, 'r2')
	await deleteR2Bucket({
		name,
		dryRun,
		emptyIfNonEmpty: true,
		accountId,
		apiToken,
		fetcher,
		sleep,
		maxAttempts,
		deadlineMs,
		now,
	})
}

type PreviewQueueInput = Parameters<typeof deleteCloudflareQueue>[0]

export async function removePreviewQueueConsumers(input: PreviewQueueInput) {
	assertPreviewResourceName(input.name, 'queue')
	await removeCloudflareQueueConsumers(input)
}

export async function deletePreviewQueue(input: PreviewQueueInput) {
	assertPreviewResourceName(input.name, 'queue')
	await deleteCloudflareQueue(input)
}

async function ensurePreviewResources(options: CliOptions) {
	const {
		d1DatabaseName,
		auditD1DatabaseName,
		oauthKvTitle,
		bundleArtifactsKvTitle,
		communityAssetsBucketName,
		emailBlobsBucketName,
		repoSessionBlobsBucketName,
		webhookDispatchQueueName,
		webhookDispatchDeadLetterQueueName,
	} = buildPreviewResourceNames(options.workerName)
	const d1 = ensureD1Database({
		name: d1DatabaseName,
		location: options.d1Location,
		dryRun: options.dryRun,
	})
	const auditD1 = ensureD1Database({
		name: auditD1DatabaseName,
		location: options.d1Location,
		dryRun: options.dryRun,
	})
	const oauthKv = ensureKvNamespace({
		title: oauthKvTitle,
		dryRun: options.dryRun,
	})
	const bundleArtifactsKv = ensureKvNamespace({
		title: bundleArtifactsKvTitle,
		dryRun: options.dryRun,
	})
	const emailBlobs = ensureR2Bucket({
		name: emailBlobsBucketName,
		dryRun: options.dryRun,
	})
	const repoSessionBlobs = ensureR2Bucket({
		name: repoSessionBlobsBucketName,
		dryRun: options.dryRun,
	})
	const communityAssets = ensureR2Bucket({
		name: communityAssetsBucketName,
		dryRun: options.dryRun,
	})
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
	const existingQueues = options.dryRun
		? []
		: await listCloudflareQueues(queueClient)
	await ensureCloudflareQueue({
		...queueClient,
		name: webhookDispatchQueueName,
		existingQueues,
	})
	await ensureCloudflareQueue({
		...queueClient,
		name: webhookDispatchDeadLetterQueueName,
		existingQueues,
	})

	// Same classifier as production (tools/ci/production-resources.ts), run
	// against this preview's three script names. A dry run has no live fleet
	// to probe and nothing to protect, so it plans as a fresh preview.
	const deployState: OriginProductionScriptState =
		options.dryRun || !accountId || !apiToken
			? {
					mode: 'fresh',
					reason: 'Dry run; plan as a fresh preview fleet.',
					originOwnedTransferredClassNames: [],
				}
			: await inspectOriginProductionScriptState({
					accountId,
					apiToken,
					scriptNames: previewFleetScriptNames(options.workerName),
				})
	const deployPlan = planOriginPreviewDeploy(deployState)
	console.error(
		`Origin preview deploy state: ${deployPlan.mode} (${deployPlan.originEntry} entry). ${deployPlan.reason}`,
	)

	const generatedConfigPath = await writeGeneratedWranglerConfig({
		baseConfigPath: options.wranglerConfigPath,
		outConfigPath: options.outConfigPath,
		envName: 'preview',
		workerName: options.workerName,
		// Preview uploads the same slim origin entry as steady-state
		// production: platform and runtime own every Durable Object class, so
		// the origin never needs the full `index.ts` bootstrap. The full entry
		// is only the fallback for a legacy preview script that still owns
		// transferred classes (see planOriginPreviewDeploy).
		...(deployPlan.originEntry === 'slim'
			? { mainEntryPath: defaultProductionEntryPath }
			: {}),
		d1DatabaseName: d1.name,
		d1DatabaseId: d1.id,
		auditD1DatabaseName: auditD1.name,
		auditD1DatabaseId: auditD1.id,
		oauthKvId: oauthKv.id,
		bundleArtifactsKvId: bundleArtifactsKv.id,
		communityAssetsBucketName: communityAssets.name,
		emailBlobsBucketName: emailBlobs.name,
		repoSessionBlobsBucketName: repoSessionBlobs.name,
		workerVars: {
			CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
		},
		queueBindings: [
			{
				binding: 'WEBHOOK_DISPATCH_QUEUE',
				queue: webhookDispatchQueueName,
				deadLetterQueue: webhookDispatchDeadLetterQueueName,
			},
		],
		serviceBindings: [
			{
				binding: 'JOBS',
				service: `${options.workerName}-jobs`,
			},
			{
				binding: 'HIGHLIGHT',
				service: `${options.workerName}-highlight`,
			},
		],
	})

	const generatedConfig = parseJsonc<Record<string, unknown>>(
		await readFile(generatedConfigPath, 'utf8'),
	)
	stripOriginDurableObjectMigrations(generatedConfig, 'preview')
	await writeFile(
		generatedConfigPath,
		`${JSON.stringify(generatedConfig, null, '\t')}\n`,
		'utf8',
	)

	// Emit GitHub Actions-friendly outputs (stdout only).
	console.log(`wrangler_config=${generatedConfigPath}`)
	console.log(`origin_deploy_mode=${deployPlan.mode}`)
	console.log(`origin_entry=${deployPlan.originEntry}`)
	console.log(`d1_database_name=${d1.name}`)
	console.log(`d1_database_id=${d1.id}`)
	console.log(`audit_d1_database_name=${auditD1.name}`)
	console.log(`audit_d1_database_id=${auditD1.id}`)
	console.log(`oauth_kv_title=${oauthKv.title}`)
	console.log(`oauth_kv_id=${oauthKv.id}`)
	console.log(`bundle_artifacts_kv_title=${bundleArtifactsKv.title}`)
	console.log(`bundle_artifacts_kv_id=${bundleArtifactsKv.id}`)
	console.log(`community_assets_bucket_name=${communityAssets.name}`)
	console.log(`email_blobs_bucket_name=${emailBlobs.name}`)
	console.log(`repo_session_blobs_bucket_name=${repoSessionBlobs.name}`)
	console.log(`webhook_dispatch_queue_name=${webhookDispatchQueueName}`)
	console.log(
		`webhook_dispatch_dead_letter_queue_name=${webhookDispatchDeadLetterQueueName}`,
	)
}

function listMockServerNames() {
	const mockServersRoot = path.resolve('packages/mock-servers')
	let entries: Array<string>
	try {
		entries = readdirSync(mockServersRoot)
	} catch {
		return []
	}

	return entries.filter((entry) => {
		const dir = path.join(mockServersRoot, entry)
		try {
			if (!statSync(dir).isDirectory()) {
				return false
			}
		} catch {
			return false
		}
		return readdirSync(dir).some((file) => file === 'wrangler.jsonc')
	})
}

export function listPreviewWorkerNames(workerName: string) {
	return [
		`${workerName}-runtime`,
		`${workerName}-platform`,
		workerName,
		`${workerName}-jobs`,
		`${workerName}-highlight`,
		...listMockServerNames().map((service) => `${workerName}-mock-${service}`),
	]
}

export type PreviewCleanupFailure = {
	resource: string
	message: string
}

export type PreviewCleanupOptions = {
	workerName: string
	dryRun: boolean
	sleep?: (ms: number) => Promise<void>
	deadlineMs?: number
	now?: () => number
	fetcher?: typeof fetch
	accountId?: string
	apiToken?: string
}

export function formatPreviewCleanupFailure(
	workerName: string,
	failures: ReadonlyArray<PreviewCleanupFailure>,
) {
	const lines = failures.map(
		(failure) => `  - ${failure.resource}: ${failure.message}`,
	)
	return [
		`Preview cleanup failed for ${String(failures.length)} resource(s) of ${workerName}. Already-missing resources were treated as success. Re-run:`,
		`  node tools/ci/preview-resources.ts cleanup --worker-name ${workerName}`,
		'or the preview workflow_dispatch cleanup action targeting this PR.',
		'Failed resources:',
		...lines,
	].join('\n')
}

export async function cleanupPreviewResources(options: PreviewCleanupOptions) {
	const {
		d1DatabaseName,
		auditD1DatabaseName,
		oauthKvTitle,
		bundleArtifactsKvTitle,
		communityAssetsBucketName,
		emailBlobsBucketName,
		repoSessionBlobsBucketName,
		webhookDispatchQueueName,
		webhookDispatchDeadLetterQueueName,
	} = buildPreviewResourceNames(options.workerName)
	const workerNames = listPreviewWorkerNames(options.workerName)
	for (const [name, kind] of [
		...workerNames.map((name) => [name, 'worker'] as const),
		[d1DatabaseName, 'd1'] as const,
		[auditD1DatabaseName, 'd1'] as const,
		[oauthKvTitle, 'kv'] as const,
		[bundleArtifactsKvTitle, 'kv'] as const,
		[communityAssetsBucketName, 'r2'] as const,
		[emailBlobsBucketName, 'r2'] as const,
		[repoSessionBlobsBucketName, 'r2'] as const,
		[webhookDispatchQueueName, 'queue'] as const,
		[webhookDispatchDeadLetterQueueName, 'queue'] as const,
	]) {
		assertPreviewResourceName(name, kind)
	}

	const accountId =
		options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN?.trim()
	if ((!accountId || !apiToken) && !options.dryRun) {
		fail(
			'Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN for Queue cleanup.',
		)
	}
	const now = options.now ?? Date.now
	const deadlineMs = options.deadlineMs ?? now() + previewCleanupBudgetMsDefault
	const retry = {
		sleep: options.sleep,
		deadlineMs,
		now,
	}
	const queueClient = {
		accountId: accountId ?? 'dry-run-account',
		apiToken: apiToken ?? 'dry-run-token',
		dryRun: options.dryRun,
		fetcher: options.fetcher,
		...retry,
	}
	const failures: Array<PreviewCleanupFailure> = []

	async function attempt(resource: string, operation: () => Promise<void>) {
		try {
			await operation()
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			console.error(`Cleanup failed for ${resource}: ${message}`)
			failures.push({ resource, message })
		}
	}

	// Order matters, both directions: a Worker cannot be deleted while it is
	// registered as a queue consumer (code 10064), and a queue cannot be
	// deleted while a Worker still binds it as a producer (400 "still
	// referenced by a binding in a Worker"). So: consumers → Workers → queues.
	// Independent leftovers (R2 / KV / D1) run after that chain so a Worker
	// 504 cannot strand them. Permanent failures are recorded and the rest
	// of the sweep continues.
	await attempt(`queue consumers ${webhookDispatchQueueName}`, async () => {
		await removePreviewQueueConsumers({
			...queueClient,
			name: webhookDispatchQueueName,
		})
	})
	await attempt(
		`queue consumers ${webhookDispatchDeadLetterQueueName}`,
		async () => {
			await removePreviewQueueConsumers({
				...queueClient,
				name: webhookDispatchDeadLetterQueueName,
			})
		},
	)
	for (const workerName of workerNames) {
		await attempt(`worker ${workerName}`, async () => {
			await deletePreviewWorkerScript({
				name: workerName,
				dryRun: options.dryRun,
				...retry,
			})
		})
	}
	await attempt(`queue ${webhookDispatchQueueName}`, async () => {
		await deletePreviewQueue({
			...queueClient,
			name: webhookDispatchQueueName,
		})
	})
	await attempt(`queue ${webhookDispatchDeadLetterQueueName}`, async () => {
		await deletePreviewQueue({
			...queueClient,
			name: webhookDispatchDeadLetterQueueName,
		})
	})
	for (const name of [
		communityAssetsBucketName,
		emailBlobsBucketName,
		repoSessionBlobsBucketName,
	]) {
		await attempt(`r2 ${name}`, async () => {
			await deletePreviewR2Bucket({
				name,
				dryRun: options.dryRun,
				accountId,
				apiToken,
				fetcher: options.fetcher,
				...retry,
			})
		})
	}
	for (const title of [bundleArtifactsKvTitle, oauthKvTitle]) {
		await attempt(`kv ${title}`, async () => {
			await deletePreviewKvNamespace({
				title,
				dryRun: options.dryRun,
				...retry,
			})
		})
	}
	for (const name of [auditD1DatabaseName, d1DatabaseName]) {
		await attempt(`d1 ${name}`, async () => {
			await deletePreviewD1Database({
				name,
				dryRun: options.dryRun,
				...retry,
			})
		})
	}

	if (failures.length > 0) {
		throw new Error(formatPreviewCleanupFailure(options.workerName, failures))
	}
}

async function main() {
	const { command, options } = parseArgs(process.argv.slice(2))

	if (!process.env.CLOUDFLARE_API_TOKEN && !options.dryRun) {
		fail(
			'Missing CLOUDFLARE_API_TOKEN (required for Wrangler resource operations).',
		)
	}

	if (command === 'ensure') {
		await ensurePreviewResources(options)
		return
	}

	await cleanupPreviewResources(options)
}

if (isExecutedDirectly(import.meta.url)) {
	try {
		await main()
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error))
	}
}
