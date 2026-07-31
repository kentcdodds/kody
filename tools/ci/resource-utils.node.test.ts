import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

import {
	emailSendingEventTypes,
	ensureCloudflareQueue,
	ensureEmailSendingEventSubscription,
	isWranglerNotFoundOutput,
	parseJsonc,
	parseR2BucketListOutput,
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
					routes?: Array<{ pattern: string; custom_domain?: boolean }>
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
		// Hosted package apps need their own registrable domain attached to the
		// Worker. The routes are generated from the base-URL vars rather than
		// committed, because a committed route would make `wrangler dev` resolve
		// every local request as that production host.
		//
		// `routes` replaces the Worker's whole custom-domain set, so the app origin
		// must be listed too: publishing only the package-app domain detaches
		// heykody.dev and deletes its DNS record.
		const packageAppBaseUrl =
			productionConfig.env?.production?.vars?.PACKAGE_APP_BASE_URL
		expect(typeof packageAppBaseUrl).toBe('string')
		expect(productionConfig.env?.production?.routes).toEqual([
			{ pattern: 'heykody.dev', custom_domain: true },
			{
				pattern: new URL(String(packageAppBaseUrl)).hostname,
				custom_domain: true,
			},
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
					routes?: Array<{ pattern: string; custom_domain?: boolean }>
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

test('parseR2BucketListOutput reads bucket names from labelled wrangler output', () => {
	const output = [
		'Listing buckets...',
		'name:           kody-email-blobs',
		'creation_date:  2026-07-01T00:00:00.000Z',
		'',
		'name:           kody-pr-42-email-blobs',
		'creation_date:  2026-07-02T00:00:00.000Z',
	].join('\n')
	expect(parseR2BucketListOutput(output)).toEqual([
		'kody-email-blobs',
		'kody-pr-42-email-blobs',
	])
	expect(parseR2BucketListOutput('')).toEqual([])
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
