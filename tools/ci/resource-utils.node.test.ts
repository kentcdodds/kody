import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

import {
	cloudflareApiRequest,
	deleteArtifactsNamespace,
	deleteCloudflareQueue,
	emailSendingEventTypes,
	emptyR2Bucket,
	encodeR2ObjectKey,
	ensureArtifactsAccountEventSubscription,
	ensureArtifactsNamespace,
	ensureCloudflareQueue,
	ensureEmailSendingEventSubscription,
	ensurePackageAppDnsRecords,
	ensureR2BucketLifecycle,
	isPermanentCloudflareAuthFailure,
	isR2BucketAlreadyExistsOutput,
	isR2BucketNotEmptyOutput,
	isRetryableCloudflareApiError,
	isRetryableCloudflareFailure,
	isWranglerNotFoundOutput,
	parseJsonc,
	removeCloudflareQueueConsumers,
	setArtifactsNamespaceOnWranglerEnv,
	writeGeneratedWranglerConfig,
} from './resource-utils.ts'

const thisDir = path.dirname(fileURLToPath(import.meta.url))
const workerWranglerConfigPath = path.resolve(
	thisDir,
	'../../packages/worker/wrangler.jsonc',
)
const accountApi = 'https://api.cloudflare.com/client/v4/accounts/account-1'
const zoneApi = 'https://api.cloudflare.com/client/v4/zones'
const creds = { accountId: 'account-1', apiToken: 'token-1', dryRun: false }
const previewQueue = 'kody-pr-123-webhook-dispatch'

const ok = (result: unknown) => Response.json({ success: true, result })
const listed = (result: Array<unknown>) =>
	Response.json({ success: true, result, result_info: { total_pages: 1 } })
const mockFetch = (...responses: Array<Response>) => {
	const fetcher = vi.fn<typeof fetch>()
	for (const response of responses) fetcher.mockResolvedValueOnce(response)
	return fetcher
}
const requestBody = (fetcher: ReturnType<typeof mockFetch>, index: number) =>
	JSON.parse(
		String((fetcher.mock.calls[index]?.[1] as RequestInit | undefined)?.body),
	) as Record<string, unknown>
const listedPreviewQueue = () =>
	listed([{ queue_id: 'queue-preview', queue_name: previewQueue }])
const aaaa = (id: string, name: string) => ({
	id,
	type: 'AAAA',
	name,
	content: '100::',
	proxied: true,
})
const kodyappsZone = () => ok([{ id: 'zone-kodyapps', name: 'kodyapps.dev' }])

const productionArgs = (outConfigPath: string) => ({
	baseConfigPath: workerWranglerConfigPath,
	outConfigPath,
	envName: 'production' as const,
	d1DatabaseName: 'kody',
	d1DatabaseId: 'dry-run-kody',
	auditD1DatabaseName: 'kody-audit',
	auditD1DatabaseId: 'dry-run-kody-audit',
	oauthKvId: 'dry-run-kody-oauth',
	bundleArtifactsKvId: 'dry-run-kody-bundle-artifacts',
	communityAssetsBucketName: 'kody-community-assets',
	emailBlobsBucketName: 'kody-email-blobs',
	repoSessionBlobsBucketName: 'kody-repo-session-blobs',
})

type GeneratedEnv = {
	main?: string
	assets?: { run_worker_first?: Array<string> }
	d1_databases?: Array<Record<string, string>>
	r2_buckets?: Array<{ binding: string; bucket_name: string }>
	queues?: unknown
	routes?: Array<{ pattern: string; custom_domain?: boolean }>
	workers_dev?: boolean
	vars?: Record<string, unknown>
}
type GeneratedConfig = {
	main?: string
	migrations: Array<{
		tag: string
		deleted_classes?: Array<string>
		new_sqlite_classes?: Array<string>
	}>
	assets?: { run_worker_first?: Array<string> }
	env?: { production?: GeneratedEnv; preview?: GeneratedEnv }
}
const readConfig = async (outPath: string) =>
	parseJsonc<GeneratedConfig>(await readFile(outPath, 'utf8'))

async function createTempDir() {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'kody-resource-utils-'))
	return {
		dir,
		[Symbol.asyncDispose]: () => rm(dir, { force: true, recursive: true }),
	}
}

function mockProcessExit() {
	const spy = vi.spyOn(process, 'exit').mockImplementation((() => {
		throw new Error('process.exit called')
	}) as never)
	return { [Symbol.dispose]: () => spy.mockRestore() }
}

test('Wrangler / Cloudflare output and error classifiers', () => {
	const cases: Array<[(value: string) => boolean, string, boolean]> = [
		[isWranglerNotFoundOutput, 'Worker not found', true],
		[isWranglerNotFoundOutput, 'No such script exists', true],
		[isWranglerNotFoundOutput, 'The requested resource does not exist', true],
		[isWranglerNotFoundOutput, 'Authentication error [code: 10000]', false],
		[
			isR2BucketAlreadyExistsOutput,
			'✘ [ERROR] A request to the Cloudflare API (/accounts/abc/r2/buckets) failed.\n\n  The bucket you tried to create already exists, and you own it. [code: 10004]',
			true,
		],
		[isR2BucketAlreadyExistsOutput, '[code: 10004]', true],
		[
			isR2BucketAlreadyExistsOutput,
			'Authentication error [code: 10000]',
			false,
		],
		[isR2BucketAlreadyExistsOutput, '', false],
		[
			isR2BucketNotEmptyOutput,
			'The bucket you tried to delete is not empty',
			true,
		],
		[isR2BucketNotEmptyOutput, 'Authentication error [code: 10000]', false],
		[isRetryableCloudflareFailure, 'Gateway Timeout [code: 504]', true],
		[isRetryableCloudflareFailure, '✘ [ERROR] fetch failed', true],
		[
			isRetryableCloudflareFailure,
			'▲ [WARNING] A fetch request failed, likely due to a connectivity issue.\n✘ [ERROR] fetch failed',
			true,
		],
		[
			isRetryableCloudflareFailure,
			'This Worker does not exist on your account [code: 10007]',
			false,
		],
		[
			isPermanentCloudflareAuthFailure,
			'Authentication error [code: 10000]',
			true,
		],
	]
	expect(cases.filter(([fn, value, want]) => fn(value) !== want)).toEqual([])

	const apiErrors: Array<[string, boolean]> = [
		[
			'Malformed Cloudflare response (502) for /queues: upstream connect error or disconnect/reset before headers. reset reason: connection termination',
			true,
		],
		['Cloudflare API request failed (400): invalid queue name', false],
		[
			'Malformed Cloudflare response (200) for /workers/scripts/kody-runtime: --boundary',
			false,
		],
		['Cloudflare API request failed (429): Rate limited', true],
		['Cloudflare API request failed (403): Authentication error', false],
		['Cloudflare API request failed (401): unauthorized', false],
	]
	expect(
		apiErrors.filter(
			([message, want]) =>
				isRetryableCloudflareApiError(new Error(message)) !== want,
		),
	).toEqual([])
})

test('writeGeneratedWranglerConfig preserves migrations and copies environment asset routing', async () => {
	consoleError.mockImplementation(() => {})
	await using temp = await createTempDir()
	const productionOutPath = path.join(temp.dir, 'wrangler-production.json')
	await writeGeneratedWranglerConfig({
		...productionArgs(productionOutPath),
		// CI injects the app origin the same way; the deploy needs it to publish
		// a complete custom-domain set.
		workerVars: { APP_BASE_URL: 'https://heykody.dev' },
	})

	const productionConfig = await readConfig(productionOutPath)
	const production = productionConfig.env?.production
	const migrationTags = productionConfig.migrations.map((m) => m.tag)
	const v11Index = migrationTags.indexOf('v11')
	const v13Index = migrationTags.indexOf('v13')
	expect(v11Index).toBeGreaterThanOrEqual(0)
	expect(v13Index).toBeGreaterThan(v11Index)
	expect(
		productionConfig.migrations.some((m) =>
			m.deleted_classes?.includes('AppRunner'),
		),
	).toBe(false)
	expect(
		productionConfig.migrations[v13Index]?.new_sqlite_classes?.length,
	).toBeGreaterThan(0)
	expect(productionConfig.assets).toEqual(production?.assets)
	expect(productionConfig.assets?.run_worker_first?.length).toBeGreaterThan(0)
	expect(production?.d1_databases).toEqual([
		{
			binding: 'APP_DB',
			database_name: 'kody',
			database_id: 'dry-run-kody',
			migrations_dir: './migrations',
		},
		{
			binding: 'AUDIT_DB',
			database_name: 'kody-audit',
			database_id: 'dry-run-kody-audit',
			migrations_dir: './audit-migrations',
		},
	])
	expect(production?.r2_buckets).toEqual([
		{ binding: 'COMMUNITY_ASSETS', bucket_name: 'kody-community-assets' },
		{ binding: 'EMAIL_BLOBS', bucket_name: 'kody-email-blobs' },
		{ binding: 'REPO_SESSION_BLOBS', bucket_name: 'kody-repo-session-blobs' },
	])
	// Routes are generated from the base-URL vars rather than committed (a
	// committed route would make `wrangler dev` resolve every local request as
	// that production host). The package-app host is attached to the runtime
	// Worker (ADR 0016), so the main Worker publishes only the app origin.
	expect(typeof production?.vars?.PACKAGE_APP_BASE_URL).toBe('string')
	expect(production?.routes).toEqual([
		{ pattern: 'heykody.dev', custom_domain: true },
	])
	// Publishing routes otherwise drops the workers.dev trigger.
	expect(production?.workers_dev).toBe(true)

	const previewOutPath = path.join(temp.dir, 'wrangler-preview.json')
	await writeGeneratedWranglerConfig({
		baseConfigPath: workerWranglerConfigPath,
		outConfigPath: previewOutPath,
		envName: 'preview',
		workerName: 'kody-pr-123',
		d1DatabaseName: 'kody-pr-123-db',
		d1DatabaseId: 'dry-run-kody-pr-123-db',
		auditD1DatabaseName: 'kody-pr-123-audit-db',
		auditD1DatabaseId: 'dry-run-kody-pr-123-audit-db',
		oauthKvId: 'dry-run-kody-pr-123-oauth',
		bundleArtifactsKvId: 'dry-run-kody-pr-123-bundle-artifacts',
		communityAssetsBucketName: 'kody-pr-123-community-assets',
		emailBlobsBucketName: 'kody-pr-123-email-blobs',
		repoSessionBlobsBucketName: 'kody-pr-123-repo-session-blobs',
		queueBindings: [
			{
				binding: 'WEBHOOK_DISPATCH_QUEUE',
				queue: previewQueue,
				deadLetterQueue: `${previewQueue}-dlq`,
			},
		],
	})

	const previewConfig = await readConfig(previewOutPath)
	const preview = previewConfig.env?.preview
	expect(previewConfig.assets).toEqual(preview?.assets)
	expect(previewConfig.assets?.run_worker_first?.length).toBeGreaterThan(0)
	expect(preview?.d1_databases).toEqual([
		{
			binding: 'APP_DB',
			database_name: 'kody-pr-123-db',
			database_id: 'dry-run-kody-pr-123-db',
			migrations_dir: './migrations',
		},
		{
			binding: 'AUDIT_DB',
			database_name: 'kody-pr-123-audit-db',
			database_id: 'dry-run-kody-pr-123-audit-db',
			migrations_dir: './audit-migrations',
		},
	])
	// The preview R2 bucket name is overridden per preview deploy.
	expect(preview?.r2_buckets).toEqual([
		{
			binding: 'COMMUNITY_ASSETS',
			bucket_name: 'kody-pr-123-community-assets',
		},
		{ binding: 'EMAIL_BLOBS', bucket_name: 'kody-pr-123-email-blobs' },
		{
			binding: 'REPO_SESSION_BLOBS',
			bucket_name: 'kody-pr-123-repo-session-blobs',
		},
	])
	expect(preview?.queues).toMatchObject({
		producers: [{ binding: 'WEBHOOK_DISPATCH_QUEUE', queue: previewQueue }],
		consumers: [
			{ queue: previewQueue, dead_letter_queue: `${previewQueue}-dlq` },
		],
	})
	// Preview serves package apps inline on its own origin, so it publishes no
	// routes. It still sets workers_dev so secret-bulk reapply cannot drop the
	// workers.dev trigger (Cloudflare 1042).
	expect(preview?.routes).toBeUndefined()
	expect(preview?.workers_dev).toBe(true)
	expect(consoleError).toHaveBeenCalledWith(
		`Wrote generated Wrangler config: ${previewOutPath}`,
	)

	// A top-level main override supports the slim production entry.
	const slimOutPath = path.join(temp.dir, 'wrangler-slim.json')
	await writeGeneratedWranglerConfig({
		...productionArgs(slimOutPath),
		workerVars: { APP_BASE_URL: 'https://heykody.dev' },
		mainEntryPath: './src/production-worker.ts',
	})
	const slimConfig = await readConfig(slimOutPath)
	expect(slimConfig.main).toBe('./src/production-worker.ts')
	expect(slimConfig.env?.production?.main).toBeUndefined()

	// Publishing a package-app domain without the app origin would replace the
	// Worker's custom-domain set with a partial one, detaching the app origin
	// and deleting its DNS record. That must fail the deploy, not ship.
	using _exit = mockProcessExit()
	await expect(
		writeGeneratedWranglerConfig(
			productionArgs(path.join(temp.dir, 'wrangler-no-app-origin.json')),
		),
	).rejects.toThrow('process.exit called')
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('without "APP_BASE_URL"'),
	)
})

test('writeGeneratedWranglerConfig keeps legacy app hosts attached during a domain migration', async () => {
	consoleError.mockImplementation(() => {})
	await using temp = await createTempDir()
	const outPath = path.join(temp.dir, 'wrangler-production.json')
	// The heykody.dev -> heykody.app cutover shape: `routes` replaces the
	// Worker's whole custom-domain set, so omitting the legacy host would
	// detach heykody.dev and delete its DNS record.
	await writeGeneratedWranglerConfig({
		...productionArgs(outPath),
		workerVars: {
			APP_BASE_URL: 'https://heykody.app',
			APP_LEGACY_HOSTS: 'heykody.dev',
		},
	})
	const production = (await readConfig(outPath)).env?.production
	const packageAppBaseUrl = production?.vars?.PACKAGE_APP_BASE_URL
	expect(typeof packageAppBaseUrl).toBe('string')
	expect(production?.routes).toEqual([
		{ pattern: 'heykody.app', custom_domain: true },
		{ pattern: 'heykody.dev', custom_domain: true },
	])

	// A legacy host equal to the package-app domain would collapse the
	// package-app isolation boundary, and a malformed hostname would publish a
	// bogus custom-domain route; both must fail the deploy.
	using _exit = mockProcessExit()
	for (const legacyHosts of [
		new URL(String(packageAppBaseUrl)).hostname,
		'heykody..dev',
	]) {
		await expect(
			writeGeneratedWranglerConfig({
				...productionArgs(path.join(temp.dir, 'wrangler-bad-legacy.json')),
				workerVars: {
					APP_BASE_URL: 'https://heykody.app',
					APP_LEGACY_HOSTS: legacyHosts,
				},
			}),
		).rejects.toThrow('process.exit called')
	}
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('APP_LEGACY_HOSTS'),
	)
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('invalid hostname'),
	)
})

test('writeGeneratedWranglerConfig rejects invalid environment asset config', async () => {
	consoleError.mockImplementation(() => {})
	await using temp = await createTempDir()
	using _exit = mockProcessExit()
	const baseConfigPath = path.join(temp.dir, 'wrangler.jsonc')
	await writeFile(
		baseConfigPath,
		JSON.stringify({
			env: {
				production: {
					assets: [],
					d1_databases: [{ binding: 'APP_DB' }],
					kv_namespaces: [
						{ binding: 'OAUTH_KV' },
						{ binding: 'BUNDLE_ARTIFACTS_KV' },
					],
				},
			},
		}),
		'utf8',
	)
	await expect(
		writeGeneratedWranglerConfig({
			...productionArgs(path.join(temp.dir, 'out.json')),
			baseConfigPath,
		}),
	).rejects.toThrow('process.exit called')
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('env.production.assets'),
	)
})

test('ensureR2BucketLifecycle dry-run returns the policy without calling Wrangler', () => {
	consoleError.mockImplementation(() => {})
	const policy = {
		rules: [
			{ id: 'expire-example', enabled: true, conditions: { prefix: 'v1/' } },
		],
	}
	expect(
		ensureR2BucketLifecycle({ name: 'kody-nx-cache', policy, dryRun: true }),
	).toEqual({ name: 'kody-nx-cache', policy })
	expect(consoleError).toHaveBeenCalledWith(
		'[dry-run] set R2 lifecycle for kody-nx-cache',
	)
})

test('Queue and Email Sending subscription ensure creates and reconciles Cloudflare resources', async () => {
	consoleError.mockImplementation(() => {})
	const queueFetch = mockFetch(
		listed([]),
		ok({ queue_id: 'queue-1', queue_name: 'kody-email-delivery' }),
	)
	const queue = await ensureCloudflareQueue({
		...creds,
		name: 'kody-email-delivery',
		fetcher: queueFetch,
	})
	expect(queue).toEqual({ id: 'queue-1', name: 'kody-email-delivery' })
	expect(queueFetch).toHaveBeenNthCalledWith(
		2,
		`${accountApi}/queues`,
		expect.objectContaining({
			method: 'POST',
			body: JSON.stringify({ queue_name: 'kody-email-delivery' }),
		}),
	)

	const reusedQueueFetch = mockFetch()
	await expect(
		ensureCloudflareQueue({
			...creds,
			name: 'kody-email-delivery',
			existingQueues: [
				{ queue_id: 'queue-existing', queue_name: 'kody-email-delivery' },
			],
			fetcher: reusedQueueFetch,
		}),
	).resolves.toEqual({ id: 'queue-existing', name: 'kody-email-delivery' })
	expect(reusedQueueFetch).not.toHaveBeenCalled()

	const subscriptionArgs = {
		...creds,
		name: 'kody-email-delivery-events',
		queueId: queue.id,
		domain: 'inbox.example.com',
		zoneId: 'zone-1',
	}
	const source = {
		type: 'email.sending',
		domain: 'inbox.example.com',
		zone_id: 'zone-1',
	}
	const destination = { type: 'queues.queue', queue_id: 'queue-1' }
	const updateFetch = mockFetch(
		listed([
			{
				id: 'subscription-old',
				name: 'kody-email-delivery-events',
				enabled: true,
				events: ['message.delivered'],
				source,
				destination: { type: 'queues.queue', queue_id: 'queue-old' },
			},
		]),
		ok({ id: 'subscription-old', name: 'kody-email-delivery-events' }),
	)
	await expect(
		ensureEmailSendingEventSubscription({
			...subscriptionArgs,
			fetcher: updateFetch,
		}),
	).resolves.toEqual({
		id: 'subscription-old',
		name: 'kody-email-delivery-events',
	})
	expect(updateFetch).toHaveBeenNthCalledWith(
		2,
		`${accountApi}/event_subscriptions/subscriptions/subscription-old`,
		expect.objectContaining({
			method: 'PATCH',
			signal: expect.any(AbortSignal),
		}),
	)
	const updateBody = requestBody(updateFetch, 1)
	expect(updateBody).toMatchObject({
		name: 'kody-email-delivery-events',
		destination,
		events: [...emailSendingEventTypes],
	})
	expect(updateBody).not.toHaveProperty('source')

	const createFetch = mockFetch(
		listed([]),
		ok({ id: 'subscription-new', name: 'kody-email-delivery-events' }),
	)
	await ensureEmailSendingEventSubscription({
		...subscriptionArgs,
		fetcher: createFetch,
	})
	expect(createFetch.mock.calls[1]?.[0]).toBe(
		`${accountApi}/event_subscriptions/subscriptions`,
	)
	expect(requestBody(createFetch, 1)).toMatchObject({
		name: 'kody-email-delivery-events',
		source,
		destination,
		events: [...emailSendingEventTypes],
	})
})

test('ensureArtifactsAccountEventSubscription creates account-level lifecycle subscription', async () => {
	consoleError.mockImplementation(() => {})
	const fetcher = mockFetch(
		listed([]),
		ok({
			id: 'artifacts-subscription-1',
			name: 'kody-artifacts-lifecycle-events',
		}),
	)
	await expect(
		ensureArtifactsAccountEventSubscription({
			...creds,
			name: 'kody-artifacts-lifecycle-events',
			queueId: 'queue-artifacts',
			fetcher,
		}),
	).resolves.toEqual({
		id: 'artifacts-subscription-1',
		name: 'kody-artifacts-lifecycle-events',
	})
	expect(fetcher).toHaveBeenNthCalledWith(
		2,
		`${accountApi}/event_subscriptions/subscriptions`,
		expect.objectContaining({
			method: 'POST',
			body: JSON.stringify({
				name: 'kody-artifacts-lifecycle-events',
				enabled: true,
				source: { type: 'artifacts' },
				destination: { type: 'queues.queue', queue_id: 'queue-artifacts' },
				events: ['repo.created', 'repo.deleted', 'repo.pushed'],
			}),
		}),
	)
})

test('ensureArtifactsNamespace creates when missing and deleteArtifactsNamespace empties then deletes', async () => {
	consoleError.mockImplementation(() => {})
	const ensureFetcher = mockFetch(
		Response.json(
			{
				success: false,
				result: null,
				errors: [{ code: 1000, message: 'namespace not found' }],
			},
			{ status: 404 },
		),
		ok({ namespace: 'kody-pr-42' }),
	)
	await expect(
		ensureArtifactsNamespace({
			...creds,
			namespace: 'kody-pr-42',
			fetcher: ensureFetcher,
		}),
	).resolves.toEqual({ namespace: 'kody-pr-42' })
	expect(ensureFetcher).toHaveBeenNthCalledWith(
		2,
		`${accountApi}/artifacts/namespaces`,
		expect.objectContaining({
			method: 'POST',
			body: JSON.stringify({ namespace: 'kody-pr-42' }),
		}),
	)

	const deleteFetcher = mockFetch(
		listed([{ name: 'package-a' }, { name: 'package-b' }]),
		ok({ id: 'repo-a' }),
		ok({ id: 'repo-b' }),
		ok({ namespace: 'kody-pr-42' }),
	)
	await deleteArtifactsNamespace({
		...creds,
		namespace: 'kody-pr-42',
		fetcher: deleteFetcher,
	})
	expect(
		deleteFetcher.mock.calls.map(([url, init]) => [String(url), init?.method]),
	).toEqual([
		[`${accountApi}/artifacts/namespaces/kody-pr-42/repos?limit=200`, 'GET'],
		[`${accountApi}/artifacts/namespaces/kody-pr-42/repos/package-a`, 'DELETE'],
		[`${accountApi}/artifacts/namespaces/kody-pr-42/repos/package-b`, 'DELETE'],
		[`${accountApi}/artifacts/namespaces/kody-pr-42`, 'DELETE'],
	])
})

test('setArtifactsNamespaceOnWranglerEnv rewrites binding and var together', () => {
	const envRecord: Record<string, unknown> = {
		vars: { ARTIFACTS_NAMESPACE: 'preview', OTHER: 'keep' },
		artifacts: [{ binding: 'ARTIFACTS', namespace: 'preview' }],
	}
	setArtifactsNamespaceOnWranglerEnv(envRecord, 'kody-pr-9')
	expect(envRecord.vars).toEqual({
		ARTIFACTS_NAMESPACE: 'kody-pr-9',
		OTHER: 'keep',
	})
	expect(envRecord.artifacts).toEqual([
		{ binding: 'ARTIFACTS', namespace: 'kody-pr-9' },
	])
})

const queueStillReferencedResponse = () =>
	Response.json(
		{
			success: false,
			errors: [
				{
					code: 11004,
					message: `Cannot delete queue '${previewQueue}' that is still referenced by a binding in a Worker. Unbind queue '${previewQueue}' from the Workers 'kody-pr-123'; then try again.`,
				},
			],
		},
		{ status: 400 },
	)

test('deleteCloudflareQueue deletes immediately, retries binding release, then gives up', async () => {
	consoleError.mockImplementation(() => {})
	const immediateFetcher = mockFetch(listedPreviewQueue(), ok(null))
	await deleteCloudflareQueue({
		...creds,
		name: previewQueue,
		fetcher: immediateFetcher,
	})
	expect(immediateFetcher).toHaveBeenNthCalledWith(
		2,
		`${accountApi}/queues/queue-preview`,
		expect.objectContaining({ method: 'DELETE' }),
	)

	const retryFetcher = mockFetch(
		listedPreviewQueue(),
		queueStillReferencedResponse(),
		ok(null),
	)
	const sleep = vi.fn(async () => {})
	await deleteCloudflareQueue({
		...creds,
		name: previewQueue,
		fetcher: retryFetcher,
		sleep,
	})
	expect(retryFetcher).toHaveBeenCalledTimes(3)
	expect(sleep).toHaveBeenCalledTimes(1)

	const stuckFetcher = mockFetch(listedPreviewQueue()).mockImplementation(
		async () => queueStillReferencedResponse(),
	)
	await expect(
		deleteCloudflareQueue({
			...creds,
			name: previewQueue,
			fetcher: stuckFetcher,
			sleep: async () => {},
		}),
	).rejects.toThrow('still referenced by a binding in a Worker')
	// One list call plus five delete attempts.
	expect(stuckFetcher).toHaveBeenCalledTimes(6)
})

test('removeCloudflareQueueConsumers deregisters consumers and no-ops when none exist', async () => {
	consoleError.mockImplementation(() => {})
	const fetcher = mockFetch(
		listedPreviewQueue(),
		ok([{ consumer_id: 'consumer-1', script: 'kody-pr-123', type: 'worker' }]),
		ok(null),
	)
	await removeCloudflareQueueConsumers({
		...creds,
		name: previewQueue,
		fetcher,
	})
	expect(fetcher).toHaveBeenNthCalledWith(
		3,
		`${accountApi}/queues/queue-preview/consumers/consumer-1`,
		expect.objectContaining({ method: 'DELETE' }),
	)

	const missingQueueFetcher = mockFetch(listed([]))
	await removeCloudflareQueueConsumers({
		...creds,
		name: previewQueue,
		fetcher: missingQueueFetcher,
	})
	expect(missingQueueFetcher).toHaveBeenCalledTimes(1)

	const emptyConsumersFetcher = mockFetch(listedPreviewQueue(), ok([]))
	await removeCloudflareQueueConsumers({
		...creds,
		name: previewQueue,
		fetcher: emptyConsumersFetcher,
	})
	expect(emptyConsumersFetcher).toHaveBeenCalledTimes(2)
})

test('Cloudflare API requests retry gateway blips, null bodies, and 429s but not 403', async () => {
	consoleError.mockImplementation(() => {})
	type Request = Pick<
		Parameters<typeof cloudflareApiRequest>[0],
		'pathname' | 'method' | 'body'
	>
	const create: Request = {
		pathname: '/queues',
		method: 'POST',
		body: { queue_name: 'kody-email-delivery' },
	}
	const retried: Array<[Response, Request]> = [
		[
			new Response(
				'upstream connect error or disconnect/reset before headers. reset reason: connection termination',
				{ status: 502, statusText: 'Bad Gateway' },
			),
			create,
		],
		[
			new Response('null', { status: 200 }),
			{ pathname: '/queues?page=1&per_page=100' },
		],
		[
			Response.json(
				{ success: false, errors: [{ code: 10000, message: 'Rate limited' }] },
				{ status: 429 },
			),
			create,
		],
	]
	for (const [firstResponse, request] of retried) {
		const result = { queue_id: 'queue-1', queue_name: 'kody-email-delivery' }
		const fetcher = mockFetch(firstResponse, ok(result))
		const payload = await cloudflareApiRequest({
			accountId: 'account-1',
			apiToken: 'token-1',
			...request,
			fetcher,
			sleep: async () => {},
		})
		expect(payload.result).toEqual(result)
		expect(fetcher).toHaveBeenCalledTimes(2)
	}

	const forbidden = vi.fn<typeof fetch>().mockResolvedValue(
		Response.json(
			{
				success: false,
				errors: [{ code: 10000, message: 'Authentication error' }],
			},
			{ status: 403 },
		),
	)
	await expect(
		cloudflareApiRequest({
			accountId: 'account-1',
			apiToken: 'token-1',
			pathname: '/queues?page=1&per_page=100',
			fetcher: forbidden,
			sleep: async () => {},
		}),
	).rejects.toThrow('Cloudflare API request failed (403): Authentication error')
	expect(forbidden).toHaveBeenCalledTimes(1)
})

test('emptyR2Bucket deletes nested keys with literal slashes', async () => {
	consoleError.mockImplementation(() => {})
	const deletedUrls: Array<string> = []
	const fetcher = vi
		.fn<typeof fetch>()
		.mockImplementation(async (input, init) => {
			if ((init?.method ?? 'GET') === 'DELETE') {
				deletedUrls.push(String(input))
				return ok({ key: 'ok' })
			}
			return listed([
				{ key: 'seeded/blob.bin' },
				{ key: 'path/to/weird name.bin' },
			])
		})
	await emptyR2Bucket({
		accountId: 'test-account',
		apiToken: 'test-token',
		name: 'kody-pr-42-email-blobs',
		fetcher,
	})
	expect(deletedUrls).toEqual([
		expect.stringContaining(
			'/r2/buckets/kody-pr-42-email-blobs/objects/seeded/blob.bin',
		),
		expect.stringContaining(
			'/r2/buckets/kody-pr-42-email-blobs/objects/path/to/weird%20name.bin',
		),
	])
	expect(deletedUrls.some((url) => url.includes('%2F'))).toBe(false)
	expect(
		['seeded/blob.bin', 'path/to/weird name.bin', 'a//b'].map(
			encodeR2ObjectKey,
		),
	).toEqual(['seeded/blob.bin', 'path/to/weird%20name.bin', 'a//b'])
})

test('ensurePackageAppDnsRecords creates proxied apex/wildcard records and reuses them', async () => {
	consoleError.mockImplementation(() => {})
	const dnsArgs = { ...creds, packageAppHostname: 'kodyapps.dev' }
	const createFetcher = mockFetch(
		kodyappsZone(),
		ok([]),
		ok(aaaa('dns-apex', 'kodyapps.dev')),
		ok([]),
		ok(aaaa('dns-wildcard', '*.kodyapps.dev')),
	)
	await ensurePackageAppDnsRecords({ ...dnsArgs, fetcher: createFetcher })

	const records = `${zoneApi}/zone-kodyapps/dns_records`
	const createRecord = (name: string) =>
		expect.objectContaining({
			method: 'POST',
			body: JSON.stringify({
				type: 'AAAA',
				name,
				content: '100::',
				proxied: true,
				ttl: 1,
			}),
		})
	const get = expect.objectContaining({ method: 'GET' })
	// The list queries are name-only on purpose: a type filter would hide
	// conflicting A/CNAME records at the same name.
	expect(createFetcher.mock.calls).toEqual([
		[`${zoneApi}?name=kodyapps.dev&account.id=account-1&status=active`, get],
		[`${records}?name=kodyapps.dev`, get],
		[records, createRecord('kodyapps.dev')],
		[`${records}?name=${encodeURIComponent('*.kodyapps.dev')}`, get],
		[records, createRecord('*.kodyapps.dev')],
	])

	const reuseFetcher = mockFetch(
		kodyappsZone(),
		ok([aaaa('dns-existing-apex', 'kodyapps.dev')]),
		ok([aaaa('dns-existing', '*.kodyapps.dev')]),
	)
	await ensurePackageAppDnsRecords({ ...dnsArgs, fetcher: reuseFetcher })
	expect(reuseFetcher).toHaveBeenCalledTimes(3)
})

test('ensurePackageAppDnsRecords fails closed on conflicting DNS records', async () => {
	consoleError.mockImplementation(() => {})
	using _exit = mockProcessExit()
	const dnsArgs = { ...creds, packageAppHostname: 'kodyapps.dev' }

	const wrongTypeFetcher = mockFetch(
		kodyappsZone(),
		ok([
			{
				id: 'dns-conflicting',
				type: 'CNAME',
				name: 'kodyapps.dev',
				content: 'somewhere-else.example',
				proxied: false,
			},
		]),
	)
	await expect(
		ensurePackageAppDnsRecords({ ...dnsArgs, fetcher: wrongTypeFetcher }),
	).rejects.toThrow('process.exit called')
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('found CNAME somewhere-else.example'),
	)
	expect(wrongTypeFetcher).toHaveBeenCalledTimes(2)

	const strayRecordFetcher = mockFetch(
		kodyappsZone(),
		ok([
			aaaa('dns-required', 'kodyapps.dev'),
			{
				id: 'dns-stray',
				type: 'A',
				name: 'kodyapps.dev',
				content: '192.0.2.1',
				proxied: false,
			},
		]),
	)
	await expect(
		ensurePackageAppDnsRecords({ ...dnsArgs, fetcher: strayRecordFetcher }),
	).rejects.toThrow('process.exit called')
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('found A 192.0.2.1'),
	)
})
