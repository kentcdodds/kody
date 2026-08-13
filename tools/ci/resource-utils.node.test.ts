import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

import {
	cloudflareApiRequest,
	deleteCloudflareQueue,
	emailSendingEventTypes,
	ensureArtifactsAccountEventSubscription,
	ensureCloudflareQueue,
	ensureEmailSendingEventSubscription,
	ensurePackageAppDnsRecords,
	isR2BucketAlreadyExistsOutput,
	isRetryableCloudflareApiError,
	isWranglerNotFoundOutput,
	parseJsonc,
	removeCloudflareQueueConsumers,
	writeGeneratedWranglerConfig,
} from './resource-utils.ts'

const thisDir = path.dirname(fileURLToPath(import.meta.url))
const workerWranglerConfigPath = path.resolve(
	thisDir,
	'../../packages/worker/wrangler.jsonc',
)

test('isWranglerNotFoundOutput recognizes common Wrangler missing-resource messages', () => {
	expect(isWranglerNotFoundOutput('Worker not found')).toBe(true)
	expect(isWranglerNotFoundOutput('No such script exists')).toBe(true)
	expect(
		isWranglerNotFoundOutput('The requested resource does not exist'),
	).toBe(true)
	expect(isWranglerNotFoundOutput('Authentication error [code: 10000]')).toBe(
		false,
	)
})

test('writeGeneratedWranglerConfig preserves migrations and copies environment asset routing', async () => {
	consoleError.mockImplementation(() => {})
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-resource-utils-'))

	try {
		const productionOutPath = path.join(
			tempDir,
			'wrangler-production.generated.json',
		)
		await writeGeneratedWranglerConfig({
			baseConfigPath: workerWranglerConfigPath,
			outConfigPath: productionOutPath,
			envName: 'production',
			d1DatabaseName: 'kody',
			d1DatabaseId: 'dry-run-kody',
			auditD1DatabaseName: 'kody-audit',
			auditD1DatabaseId: 'dry-run-kody-audit',
			oauthKvId: 'dry-run-kody-oauth',
			bundleArtifactsKvId: 'dry-run-kody-bundle-artifacts',
			communityAssetsBucketName: 'kody-community-assets',
			emailBlobsBucketName: 'kody-email-blobs',
			// CI injects the app origin the same way; the deploy needs it to publish
			// a complete custom-domain set.
			workerVars: { APP_BASE_URL: 'https://heykody.dev' },
		})

		const productionConfig = parseJsonc<{
			migrations: Array<{
				tag: string
				deleted_classes?: Array<string>
				new_sqlite_classes?: Array<string>
			}>
			assets?: { run_worker_first?: Array<string> }
			env?: {
				production?: {
					assets?: { run_worker_first?: Array<string> }
					d1_databases?: Array<{
						binding: string
						database_name: string
						database_id: string
						migrations_dir: string
					}>
					r2_buckets?: Array<{ binding: string; bucket_name: string }>
					routes?: Array<{
						pattern: string
						custom_domain?: boolean
						zone_name?: string
					}>
					workers_dev?: boolean
					vars?: Record<string, unknown>
				}
			}
		}>(await readFile(productionOutPath, 'utf8'))
		const migrationTags = productionConfig.migrations.map(
			(migration) => migration.tag,
		)
		const v11Index = migrationTags.indexOf('v11')
		const v13Index = migrationTags.indexOf('v13')

		expect(v11Index).toBeGreaterThanOrEqual(0)
		expect(v13Index).toBeGreaterThan(v11Index)
		expect(
			productionConfig.migrations.some((migration) => {
				return migration.deleted_classes?.includes('AppRunner')
			}),
		).toBe(false)
		expect(
			productionConfig.migrations[v13Index]?.new_sqlite_classes?.length,
		).toBeGreaterThan(0)
		expect(productionConfig.assets).toEqual(
			productionConfig.env?.production?.assets,
		)
		expect(productionConfig.assets?.run_worker_first?.length).toBeGreaterThan(0)
		expect(productionConfig.env?.production?.d1_databases).toEqual([
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
		expect(productionConfig.env?.production?.r2_buckets).toEqual([
			{ binding: 'COMMUNITY_ASSETS', bucket_name: 'kody-community-assets' },
			{ binding: 'EMAIL_BLOBS', bucket_name: 'kody-email-blobs' },
		])
		// The routes are generated from the base-URL vars rather than committed,
		// because a committed route would make `wrangler dev` resolve every local
		// request as that production host. The package-app host is attached to
		// the runtime Worker (ADR 0016), so the main Worker publishes only the
		// app origin (plus legacy origins).
		const packageAppBaseUrl =
			productionConfig.env?.production?.vars?.PACKAGE_APP_BASE_URL
		expect(typeof packageAppBaseUrl).toBe('string')
		const packageAppHostname = new URL(String(packageAppBaseUrl)).hostname
		expect(productionConfig.env?.production?.routes).toEqual([
			{ pattern: 'heykody.dev', custom_domain: true },
		])
		// Publishing routes otherwise drops the workers.dev trigger.
		expect(productionConfig.env?.production?.workers_dev).toBe(true)

		const previewOutPath = path.join(tempDir, 'wrangler-preview.generated.json')
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
			queueBindings: [
				{
					binding: 'WEBHOOK_DISPATCH_QUEUE',
					queue: 'kody-pr-123-webhook-dispatch',
					deadLetterQueue: 'kody-pr-123-webhook-dispatch-dlq',
				},
			],
		})

		const previewConfig = parseJsonc<{
			assets?: { run_worker_first?: Array<string> }
			env?: {
				preview?: {
					assets?: { run_worker_first?: Array<string> }
					d1_databases?: Array<{
						binding: string
						database_name: string
						database_id: string
						migrations_dir: string
					}>
					r2_buckets?: Array<{ binding: string; bucket_name: string }>
					queues?: {
						producers: Array<{ binding: string; queue: string }>
						consumers: Array<{
							queue: string
							dead_letter_queue: string
						}>
					}
					routes?: Array<{
						pattern: string
						custom_domain?: boolean
						zone_name?: string
					}>
				}
			}
		}>(await readFile(previewOutPath, 'utf8'))
		expect(previewConfig.assets).toEqual(previewConfig.env?.preview?.assets)
		expect(previewConfig.assets?.run_worker_first?.length).toBeGreaterThan(0)
		expect(previewConfig.env?.preview?.d1_databases).toEqual([
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
		expect(previewConfig.env?.preview?.r2_buckets).toEqual([
			{
				binding: 'COMMUNITY_ASSETS',
				bucket_name: 'kody-pr-123-community-assets',
			},
			{ binding: 'EMAIL_BLOBS', bucket_name: 'kody-pr-123-email-blobs' },
		])
		expect(previewConfig.env?.preview?.queues).toMatchObject({
			producers: [
				{
					binding: 'WEBHOOK_DISPATCH_QUEUE',
					queue: 'kody-pr-123-webhook-dispatch',
				},
			],
			consumers: [
				{
					queue: 'kody-pr-123-webhook-dispatch',
					dead_letter_queue: 'kody-pr-123-webhook-dispatch-dlq',
				},
			],
		})
		// Preview serves package apps inline on its own origin, so it publishes no
		// routes and keeps whatever domains and triggers it already had.
		expect(previewConfig.env?.preview?.routes).toBeUndefined()
		expect(previewConfig.env?.preview?.workers_dev).toBeUndefined()
		expect(consoleError).toHaveBeenCalledWith(
			`Wrote generated Wrangler config: ${previewOutPath}`,
		)

		// Publishing a package-app domain without the app origin would replace the
		// Worker's custom-domain set with a partial one, detaching the app origin
		// and deleting its DNS record. That must fail the deploy, not ship.
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
			throw new Error('process.exit called')
		}) as never)
		try {
			await expect(
				writeGeneratedWranglerConfig({
					baseConfigPath: workerWranglerConfigPath,
					outConfigPath: path.join(tempDir, 'wrangler-no-app-origin.json'),
					envName: 'production',
					d1DatabaseName: 'kody',
					d1DatabaseId: 'dry-run-kody',
					auditD1DatabaseName: 'kody-audit',
					auditD1DatabaseId: 'dry-run-kody-audit',
					oauthKvId: 'dry-run-kody-oauth',
					bundleArtifactsKvId: 'dry-run-kody-bundle-artifacts',
					communityAssetsBucketName: 'kody-community-assets',
					emailBlobsBucketName: 'kody-email-blobs',
				}),
			).rejects.toThrow('process.exit called')
			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining('without "APP_BASE_URL"'),
			)
		} finally {
			exitSpy.mockRestore()
		}
	} finally {
		await rm(tempDir, { force: true, recursive: true })
	}
})

test('writeGeneratedWranglerConfig keeps legacy app hosts attached during a domain migration', async () => {
	consoleError.mockImplementation(() => {})
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-legacy-hosts-'))

	try {
		const outPath = path.join(tempDir, 'wrangler-production.generated.json')
		await writeGeneratedWranglerConfig({
			baseConfigPath: workerWranglerConfigPath,
			outConfigPath: outPath,
			envName: 'production',
			d1DatabaseName: 'kody',
			d1DatabaseId: 'dry-run-kody',
			auditD1DatabaseName: 'kody-audit',
			auditD1DatabaseId: 'dry-run-kody-audit',
			oauthKvId: 'dry-run-kody-oauth',
			bundleArtifactsKvId: 'dry-run-kody-bundle-artifacts',
			communityAssetsBucketName: 'kody-community-assets',
			emailBlobsBucketName: 'kody-email-blobs',
			// The heykody.dev -> heykody.app cutover shape: the canonical origin
			// moves, and the legacy host must stay in the published route set —
			// `routes` replaces the Worker's whole custom-domain set, so omitting
			// it would detach heykody.dev and delete its DNS record.
			workerVars: {
				APP_BASE_URL: 'https://heykody.app',
				APP_LEGACY_HOSTS: 'heykody.dev',
			},
		})

		const config = parseJsonc<{
			env?: {
				production?: {
					routes?: Array<{
						pattern: string
						custom_domain?: boolean
						zone_name?: string
					}>
					vars?: Record<string, unknown>
				}
			}
		}>(await readFile(outPath, 'utf8'))
		const packageAppBaseUrl = config.env?.production?.vars?.PACKAGE_APP_BASE_URL
		expect(typeof packageAppBaseUrl).toBe('string')
		expect(config.env?.production?.routes).toEqual([
			{ pattern: 'heykody.app', custom_domain: true },
			{ pattern: 'heykody.dev', custom_domain: true },
		])

		// A legacy host equal to the package-app domain would silently collapse
		// the package-app isolation boundary, and a malformed hostname (empty
		// DNS label) would publish a bogus custom-domain route; both must fail
		// the deploy.
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
			throw new Error('process.exit called')
		}) as never)
		try {
			const failingLegacyHostValues = [
				String(new URL(String(packageAppBaseUrl)).hostname),
				'heykody..dev',
			]
			for (const legacyHosts of failingLegacyHostValues) {
				await expect(
					writeGeneratedWranglerConfig({
						baseConfigPath: workerWranglerConfigPath,
						outConfigPath: path.join(tempDir, 'wrangler-bad-legacy.json'),
						envName: 'production',
						d1DatabaseName: 'kody',
						d1DatabaseId: 'dry-run-kody',
						auditD1DatabaseName: 'kody-audit',
						auditD1DatabaseId: 'dry-run-kody-audit',
						oauthKvId: 'dry-run-kody-oauth',
						bundleArtifactsKvId: 'dry-run-kody-bundle-artifacts',
						communityAssetsBucketName: 'kody-community-assets',
						emailBlobsBucketName: 'kody-email-blobs',
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
		} finally {
			exitSpy.mockRestore()
		}
	} finally {
		await rm(tempDir, { force: true, recursive: true })
	}
})

test('isR2BucketAlreadyExistsOutput recognizes Wrangler bucket-exists errors', () => {
	expect(
		isR2BucketAlreadyExistsOutput(
			'✘ [ERROR] A request to the Cloudflare API (/accounts/abc/r2/buckets) failed.\n\n' +
				'  The bucket you tried to create already exists, and you own it. [code: 10004]',
		),
	).toBe(true)
	expect(isR2BucketAlreadyExistsOutput('[code: 10004]')).toBe(true)
	expect(
		isR2BucketAlreadyExistsOutput('Authentication error [code: 10000]'),
	).toBe(false)
	expect(isR2BucketAlreadyExistsOutput('')).toBe(false)
})

test('Queue and Email Sending subscription ensure creates and reconciles Cloudflare resources', async () => {
	consoleError.mockImplementation(() => {})
	const queueFetch = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [],
				result_info: { total_pages: 1 },
			}),
		)
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: {
					queue_id: 'queue-1',
					queue_name: 'kody-email-delivery',
				},
			}),
		)
	const queue = await ensureCloudflareQueue({
		accountId: 'account-1',
		apiToken: 'token-1',
		name: 'kody-email-delivery',
		dryRun: false,
		fetcher: queueFetch,
	})
	expect(queue).toEqual({ id: 'queue-1', name: 'kody-email-delivery' })
	expect(queueFetch).toHaveBeenNthCalledWith(
		2,
		'https://api.cloudflare.com/client/v4/accounts/account-1/queues',
		expect.objectContaining({
			method: 'POST',
			body: JSON.stringify({ queue_name: 'kody-email-delivery' }),
		}),
	)

	const listedQueues = [
		{ queue_id: 'queue-existing', queue_name: 'kody-email-delivery' },
	]
	const reusedQueueFetch = vi.fn<typeof fetch>()
	const reusedQueue = await ensureCloudflareQueue({
		accountId: 'account-1',
		apiToken: 'token-1',
		name: 'kody-email-delivery',
		dryRun: false,
		existingQueues: listedQueues,
		fetcher: reusedQueueFetch,
	})
	expect(reusedQueue).toEqual({
		id: 'queue-existing',
		name: 'kody-email-delivery',
	})
	expect(reusedQueueFetch).not.toHaveBeenCalled()

	const subscriptionFetch = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [
					{
						id: 'subscription-old',
						name: 'kody-email-delivery-events',
						enabled: true,
						events: ['message.delivered'],
						source: {
							type: 'email.sending',
							domain: 'inbox.example.com',
							zone_id: 'zone-1',
						},
						destination: {
							type: 'queues.queue',
							queue_id: 'queue-old',
						},
					},
				],
				result_info: { total_pages: 1 },
			}),
		)
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: {
					id: 'subscription-old',
					name: 'kody-email-delivery-events',
				},
			}),
		)
	const subscription = await ensureEmailSendingEventSubscription({
		accountId: 'account-1',
		apiToken: 'token-1',
		name: 'kody-email-delivery-events',
		queueId: queue.id,
		domain: 'inbox.example.com',
		zoneId: 'zone-1',
		dryRun: false,
		fetcher: subscriptionFetch,
	})
	expect(subscription).toEqual({
		id: 'subscription-old',
		name: 'kody-email-delivery-events',
	})
	expect(subscriptionFetch).toHaveBeenNthCalledWith(
		2,
		'https://api.cloudflare.com/client/v4/accounts/account-1/event_subscriptions/subscriptions/subscription-old',
		expect.objectContaining({
			method: 'PATCH',
			signal: expect.any(AbortSignal),
		}),
	)
	const updateBody = JSON.parse(
		String(
			(subscriptionFetch.mock.calls[1]?.[1] as RequestInit | undefined)?.body,
		),
	) as Record<string, unknown>
	expect(updateBody).toMatchObject({
		name: 'kody-email-delivery-events',
		destination: {
			type: 'queues.queue',
			queue_id: 'queue-1',
		},
		events: [...emailSendingEventTypes],
	})
	expect(updateBody).not.toHaveProperty('source')

	const createSubscriptionFetch = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [],
				result_info: { total_pages: 1 },
			}),
		)
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: {
					id: 'subscription-new',
					name: 'kody-email-delivery-events',
				},
			}),
		)
	await ensureEmailSendingEventSubscription({
		accountId: 'account-1',
		apiToken: 'token-1',
		name: 'kody-email-delivery-events',
		queueId: queue.id,
		domain: 'inbox.example.com',
		zoneId: 'zone-1',
		dryRun: false,
		fetcher: createSubscriptionFetch,
	})
	const createCall = createSubscriptionFetch.mock.calls[1]
	expect(createCall?.[0]).toBe(
		'https://api.cloudflare.com/client/v4/accounts/account-1/event_subscriptions/subscriptions',
	)
	const createBody = JSON.parse(
		String((createCall?.[1] as RequestInit | undefined)?.body),
	) as Record<string, unknown>
	expect(createBody).toMatchObject({
		name: 'kody-email-delivery-events',
		source: {
			type: 'email.sending',
			domain: 'inbox.example.com',
			zone_id: 'zone-1',
		},
		destination: {
			type: 'queues.queue',
			queue_id: 'queue-1',
		},
		events: [...emailSendingEventTypes],
	})
})

const queueStillReferencedResponse = () =>
	Response.json(
		{
			success: false,
			errors: [
				{
					code: 11004,
					message:
						"Cannot delete queue 'kody-pr-123-webhook-dispatch' that is still referenced by a binding in a Worker. Unbind queue 'kody-pr-123-webhook-dispatch' from the Workers 'kody-pr-123'; then try again.",
				},
			],
		},
		{ status: 400 },
	)

test('deleteCloudflareQueue deletes immediately, retries binding release, then gives up', async () => {
	consoleError.mockImplementation(() => {})
	const immediateFetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [
					{
						queue_id: 'queue-preview',
						queue_name: 'kody-pr-123-webhook-dispatch',
					},
				],
				result_info: { total_pages: 1 },
			}),
		)
		.mockResolvedValueOnce(Response.json({ success: true, result: null }))

	await deleteCloudflareQueue({
		accountId: 'account-1',
		apiToken: 'token-1',
		name: 'kody-pr-123-webhook-dispatch',
		dryRun: false,
		fetcher: immediateFetcher,
	})

	expect(immediateFetcher).toHaveBeenNthCalledWith(
		2,
		'https://api.cloudflare.com/client/v4/accounts/account-1/queues/queue-preview',
		expect.objectContaining({ method: 'DELETE' }),
	)

	const retryFetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [
					{
						queue_id: 'queue-preview',
						queue_name: 'kody-pr-123-webhook-dispatch',
					},
				],
				result_info: { total_pages: 1 },
			}),
		)
		.mockResolvedValueOnce(queueStillReferencedResponse())
		.mockResolvedValueOnce(Response.json({ success: true, result: null }))
	const sleep = vi.fn(async () => {})

	await deleteCloudflareQueue({
		accountId: 'account-1',
		apiToken: 'token-1',
		name: 'kody-pr-123-webhook-dispatch',
		dryRun: false,
		fetcher: retryFetcher,
		sleep,
	})

	expect(retryFetcher).toHaveBeenCalledTimes(3)
	expect(sleep).toHaveBeenCalledTimes(1)

	const stuckFetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [
					{
						queue_id: 'queue-preview',
						queue_name: 'kody-pr-123-webhook-dispatch',
					},
				],
				result_info: { total_pages: 1 },
			}),
		)
		.mockImplementation(async () => queueStillReferencedResponse())

	await expect(
		deleteCloudflareQueue({
			accountId: 'account-1',
			apiToken: 'token-1',
			name: 'kody-pr-123-webhook-dispatch',
			dryRun: false,
			fetcher: stuckFetcher,
			sleep: async () => {},
		}),
	).rejects.toThrow('still referenced by a binding in a Worker')

	// One list call plus five delete attempts.
	expect(stuckFetcher).toHaveBeenCalledTimes(6)
})

test('removeCloudflareQueueConsumers deregisters consumers and no-ops when none exist', async () => {
	consoleError.mockImplementation(() => {})
	const fetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [
					{
						queue_id: 'queue-preview',
						queue_name: 'kody-pr-123-webhook-dispatch',
					},
				],
				result_info: { total_pages: 1 },
			}),
		)
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [
					{ consumer_id: 'consumer-1', script: 'kody-pr-123', type: 'worker' },
				],
			}),
		)
		.mockResolvedValueOnce(Response.json({ success: true, result: null }))

	await removeCloudflareQueueConsumers({
		accountId: 'account-1',
		apiToken: 'token-1',
		name: 'kody-pr-123-webhook-dispatch',
		dryRun: false,
		fetcher,
	})

	expect(fetcher).toHaveBeenNthCalledWith(
		3,
		'https://api.cloudflare.com/client/v4/accounts/account-1/queues/queue-preview/consumers/consumer-1',
		expect.objectContaining({ method: 'DELETE' }),
	)

	const missingQueueFetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
		Response.json({
			success: true,
			result: [],
			result_info: { total_pages: 1 },
		}),
	)
	await removeCloudflareQueueConsumers({
		accountId: 'account-1',
		apiToken: 'token-1',
		name: 'kody-pr-123-webhook-dispatch',
		dryRun: false,
		fetcher: missingQueueFetcher,
	})
	expect(missingQueueFetcher).toHaveBeenCalledTimes(1)

	const emptyConsumersFetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [
					{
						queue_id: 'queue-preview',
						queue_name: 'kody-pr-123-webhook-dispatch',
					},
				],
				result_info: { total_pages: 1 },
			}),
		)
		.mockResolvedValueOnce(Response.json({ success: true, result: [] }))
	await removeCloudflareQueueConsumers({
		accountId: 'account-1',
		apiToken: 'token-1',
		name: 'kody-pr-123-webhook-dispatch',
		dryRun: false,
		fetcher: emptyConsumersFetcher,
	})
	expect(emptyConsumersFetcher).toHaveBeenCalledTimes(2)
})

test('Cloudflare API requests retry gateway HTML/text blips then succeed', async () => {
	consoleError.mockImplementation(() => {})
	const fetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			new Response(
				'upstream connect error or disconnect/reset before headers. reset reason: connection termination',
				{ status: 502, statusText: 'Bad Gateway' },
			),
		)
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: {
					queue_id: 'queue-1',
					queue_name: 'kody-email-delivery',
				},
			}),
		)
	const payload = await cloudflareApiRequest({
		accountId: 'account-1',
		apiToken: 'token-1',
		pathname: '/queues',
		method: 'POST',
		body: { queue_name: 'kody-email-delivery' },
		fetcher,
		sleep: async () => {},
	})
	expect(payload.result).toEqual({
		queue_id: 'queue-1',
		queue_name: 'kody-email-delivery',
	})
	expect(fetcher).toHaveBeenCalledTimes(2)

	const nullBodyFetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(new Response('null', { status: 200 }))
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: {
					queue_id: 'queue-2',
					queue_name: 'kody-email-delivery',
				},
			}),
		)
	const nullBodyPayload = await cloudflareApiRequest({
		accountId: 'account-1',
		apiToken: 'token-1',
		pathname: '/queues?page=1&per_page=100',
		fetcher: nullBodyFetcher,
		sleep: async () => {},
	})
	expect(nullBodyPayload.result).toEqual({
		queue_id: 'queue-2',
		queue_name: 'kody-email-delivery',
	})
	expect(nullBodyFetcher).toHaveBeenCalledTimes(2)
	expect(
		isRetryableCloudflareApiError(
			new Error(
				'Malformed Cloudflare response (502) for /queues: upstream connect error or disconnect/reset before headers. reset reason: connection termination',
			),
		),
	).toBe(true)
	expect(
		isRetryableCloudflareApiError(
			new Error('Cloudflare API request failed (400): invalid queue name'),
		),
	).toBe(false)
})

test('ensureArtifactsAccountEventSubscription creates account-level lifecycle subscription', async () => {
	consoleError.mockImplementation(() => {})
	const subscriptionFetch = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [],
				result_info: { total_pages: 1 },
			}),
		)
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: {
					id: 'artifacts-subscription-1',
					name: 'kody-artifacts-lifecycle-events',
				},
			}),
		)
	const subscription = await ensureArtifactsAccountEventSubscription({
		accountId: 'account-1',
		apiToken: 'token-1',
		name: 'kody-artifacts-lifecycle-events',
		queueId: 'queue-artifacts',
		dryRun: false,
		fetcher: subscriptionFetch,
	})
	expect(subscription).toEqual({
		id: 'artifacts-subscription-1',
		name: 'kody-artifacts-lifecycle-events',
	})
	expect(subscriptionFetch).toHaveBeenNthCalledWith(
		2,
		'https://api.cloudflare.com/client/v4/accounts/account-1/event_subscriptions/subscriptions',
		expect.objectContaining({
			method: 'POST',
			body: JSON.stringify({
				name: 'kody-artifacts-lifecycle-events',
				enabled: true,
				source: { type: 'artifacts' },
				destination: {
					type: 'queues.queue',
					queue_id: 'queue-artifacts',
				},
				events: ['repo.created', 'repo.deleted', 'repo.pushed'],
			}),
		}),
	)
})

test('ensurePackageAppDnsRecords creates proxied apex/wildcard records and reuses them', async () => {
	consoleError.mockImplementation(() => {})
	const createFetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [{ id: 'zone-kodyapps', name: 'kodyapps.dev' }],
			}),
		)
		.mockResolvedValueOnce(Response.json({ success: true, result: [] }))
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: {
					id: 'dns-apex',
					type: 'AAAA',
					name: 'kodyapps.dev',
					content: '100::',
					proxied: true,
				},
			}),
		)
		.mockResolvedValueOnce(Response.json({ success: true, result: [] }))
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: {
					id: 'dns-wildcard',
					type: 'AAAA',
					name: '*.kodyapps.dev',
					content: '100::',
					proxied: true,
				},
			}),
		)

	await ensurePackageAppDnsRecords({
		accountId: 'account-1',
		apiToken: 'token-1',
		packageAppHostname: 'kodyapps.dev',
		dryRun: false,
		fetcher: createFetcher,
	})

	expect(createFetcher).toHaveBeenNthCalledWith(
		1,
		'https://api.cloudflare.com/client/v4/zones?name=kodyapps.dev&account.id=account-1&status=active',
		expect.objectContaining({ method: 'GET' }),
	)
	// The list queries are name-only on purpose: a type filter would hide
	// conflicting A/CNAME records at the same name.
	expect(createFetcher).toHaveBeenNthCalledWith(
		2,
		'https://api.cloudflare.com/client/v4/zones/zone-kodyapps/dns_records?name=kodyapps.dev',
		expect.objectContaining({ method: 'GET' }),
	)
	expect(createFetcher).toHaveBeenNthCalledWith(
		3,
		'https://api.cloudflare.com/client/v4/zones/zone-kodyapps/dns_records',
		expect.objectContaining({
			method: 'POST',
			body: JSON.stringify({
				type: 'AAAA',
				name: 'kodyapps.dev',
				content: '100::',
				proxied: true,
				ttl: 1,
			}),
		}),
	)
	expect(createFetcher).toHaveBeenNthCalledWith(
		4,
		`https://api.cloudflare.com/client/v4/zones/zone-kodyapps/dns_records?name=${encodeURIComponent('*.kodyapps.dev')}`,
		expect.objectContaining({ method: 'GET' }),
	)
	expect(createFetcher).toHaveBeenNthCalledWith(
		5,
		'https://api.cloudflare.com/client/v4/zones/zone-kodyapps/dns_records',
		expect.objectContaining({
			method: 'POST',
			body: JSON.stringify({
				type: 'AAAA',
				name: '*.kodyapps.dev',
				content: '100::',
				proxied: true,
				ttl: 1,
			}),
		}),
	)

	const reuseFetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [{ id: 'zone-kodyapps', name: 'kodyapps.dev' }],
			}),
		)
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [
					{
						id: 'dns-existing-apex',
						type: 'AAAA',
						name: 'kodyapps.dev',
						content: '100::',
						proxied: true,
					},
				],
			}),
		)
		.mockResolvedValueOnce(
			Response.json({
				success: true,
				result: [
					{
						id: 'dns-existing',
						type: 'AAAA',
						name: '*.kodyapps.dev',
						content: '100::',
						proxied: true,
					},
				],
			}),
		)

	await ensurePackageAppDnsRecords({
		accountId: 'account-1',
		apiToken: 'token-1',
		packageAppHostname: 'kodyapps.dev',
		dryRun: false,
		fetcher: reuseFetcher,
	})

	expect(reuseFetcher).toHaveBeenCalledTimes(3)
})

test('ensurePackageAppDnsRecords fails closed on conflicting DNS records', async () => {
	consoleError.mockImplementation(() => {})
	const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
		throw new Error('process.exit called')
	}) as never)

	try {
		const wrongTypeFetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					result: [{ id: 'zone-kodyapps', name: 'kodyapps.dev' }],
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					result: [
						{
							id: 'dns-conflicting',
							type: 'CNAME',
							name: 'kodyapps.dev',
							content: 'somewhere-else.example',
							proxied: false,
						},
					],
				}),
			)

		await expect(
			ensurePackageAppDnsRecords({
				accountId: 'account-1',
				apiToken: 'token-1',
				packageAppHostname: 'kodyapps.dev',
				dryRun: false,
				fetcher: wrongTypeFetcher,
			}),
		).rejects.toThrow('process.exit called')
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('found CNAME somewhere-else.example'),
		)
		expect(wrongTypeFetcher).toHaveBeenCalledTimes(2)

		const strayRecordFetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					result: [{ id: 'zone-kodyapps', name: 'kodyapps.dev' }],
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					result: [
						{
							id: 'dns-required',
							type: 'AAAA',
							name: 'kodyapps.dev',
							content: '100::',
							proxied: true,
						},
						{
							id: 'dns-stray',
							type: 'A',
							name: 'kodyapps.dev',
							content: '192.0.2.1',
							proxied: false,
						},
					],
				}),
			)

		await expect(
			ensurePackageAppDnsRecords({
				accountId: 'account-1',
				apiToken: 'token-1',
				packageAppHostname: 'kodyapps.dev',
				dryRun: false,
				fetcher: strayRecordFetcher,
			}),
		).rejects.toThrow('process.exit called')
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('found A 192.0.2.1'),
		)
	} finally {
		exit.mockRestore()
	}
})

test('writeGeneratedWranglerConfig rejects invalid environment asset config', async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-resource-utils-'))
	const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
		throw new Error('process.exit')
	}) as typeof process.exit)
	const error = vi.spyOn(console, 'error').mockImplementation(() => {})

	try {
		const baseConfigPath = path.join(tempDir, 'wrangler.jsonc')
		const outConfigPath = path.join(
			tempDir,
			'wrangler-production.generated.json',
		)
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
				baseConfigPath,
				outConfigPath,
				envName: 'production',
				d1DatabaseName: 'kody',
				d1DatabaseId: 'dry-run-kody',
				auditD1DatabaseName: 'kody-audit',
				auditD1DatabaseId: 'dry-run-kody-audit',
				oauthKvId: 'dry-run-kody-oauth',
				bundleArtifactsKvId: 'dry-run-kody-bundle-artifacts',
				communityAssetsBucketName: 'kody-community-assets',
				emailBlobsBucketName: 'kody-email-blobs',
			}),
		).rejects.toThrow('process.exit')
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('env.production.assets'),
		)
	} finally {
		exit.mockRestore()
		error.mockRestore()
		await rm(tempDir, { force: true, recursive: true })
	}
})
