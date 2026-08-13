import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

import { generate } from './runtime-worker-config.ts'
import { parseJsonc } from './resource-utils.ts'

const runtimeBaseConfigPath = 'packages/runtime-worker/wrangler.jsonc'

function buildMainGeneratedConfig(envName: string) {
	const env = {
		durable_objects: {
			bindings: [
				{ name: 'USER_METER', class_name: 'UserMeter' },
				{
					name: 'STORAGE_RUNNER',
					class_name: 'StorageRunner',
					script_name: 'kody-runtime',
				},
				{
					name: 'RUN_LOG',
					class_name: 'RunLog',
					script_name: 'kody-runtime',
				},
			],
		},
		services: [
			{ binding: 'RUNTIME_WORKER', service: 'kody-runtime' },
			{ binding: 'JOBS', service: 'kody-pr-7-jobs', entrypoint: 'JobsService' },
		],
		workflows: [
			{
				binding: 'DYNAMIC_CALLABLE_WORKFLOWS',
				name: 'kody-runtime-dynamic-callable-workflows',
				class_name: 'DynamicCallableWorkflow',
				script_name: 'kody-runtime',
			},
		],
		d1_databases: [
			{
				binding: 'APP_DB',
				database_name: 'kody-pr-7-db',
				database_id: 'd1-app-id',
				migrations_dir: './migrations',
			},
			{
				binding: 'AUDIT_DB',
				database_name: 'kody-pr-7-audit-db',
				database_id: 'd1-audit-id',
				migrations_dir: './audit-migrations',
			},
		],
		kv_namespaces: [
			{ binding: 'OAUTH_KV', id: 'kv-oauth-id' },
			{ binding: 'BUNDLE_ARTIFACTS_KV', id: 'kv-bundle-id' },
		],
		r2_buckets: [
			{
				binding: 'COMMUNITY_ASSETS',
				bucket_name: 'kody-pr-7-community-assets',
			},
			{
				binding: 'EMAIL_BLOBS',
				bucket_name: 'kody-pr-7-email-blobs',
			},
		],
		queues: {
			producers: [
				{
					binding: 'WEBHOOK_DISPATCH_QUEUE',
					queue: 'kody-pr-7-webhook-dispatch',
				},
				...(envName === 'production'
					? [
							{
								binding: 'PLATFORM_FEEDBACK_DISPATCH_QUEUE',
								queue: 'kody-platform-feedback-dispatch',
							},
							{
								binding: 'COMMUNITY_ACTIVITY_DISPATCH_QUEUE',
								queue: 'kody-community-activity-dispatch',
							},
							{
								binding: 'SCHEDULED_DISPATCH_QUEUE',
								queue: 'kody-scheduled-dispatch',
							},
							{
								binding: 'PACKAGE_EVENTS_DISPATCH_QUEUE',
								queue: 'kody-package-events-dispatch',
							},
						]
					: []),
			],
		},
		vectorize: [
			{
				binding: 'CAPABILITY_VECTOR_INDEX',
				index_name: 'kody-capabilities-pr-7',
			},
		],
		analytics_engine_datasets: [
			{ binding: 'USAGE_EVENTS', dataset: 'kody_usage_events_pr' },
			{ binding: 'FLAG_EXPOSURES', dataset: 'kody_flag_exposures_pr' },
			{
				binding: 'MCP_PROTOCOL_EVENTS',
				dataset: 'kody_mcp_protocol_events_pr',
			},
		],
		vars: {
			APP_BASE_URL: 'https://kody-pr-7.example.workers.dev',
			PACKAGE_APP_BASE_URL:
				envName === 'production' ? 'https://kodyapps.dev' : '',
		},
	}
	return { name: 'kody', env: { [envName]: env } }
}

test('generate rewrites worker names, copies resource ids, and writes a bootstrap config', async () => {
	consoleError.mockImplementation(() => {})
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-runtime-config-'))
	try {
		const mainConfigPath = path.join(tempDir, 'main.generated.json')
		await writeFile(
			mainConfigPath,
			JSON.stringify(buildMainGeneratedConfig('preview')),
		)
		const outConfigPath = path.join(tempDir, 'runtime.generated.json')
		const bootstrapPath = path.join(tempDir, 'main-bootstrap.generated.json')

		await generate({
			envName: 'preview',
			mainConfigPath,
			runtimeWorkerName: 'kody-pr-7-runtime',
			mainWorkerName: 'kody-pr-7',
			baseConfigPath: runtimeBaseConfigPath,
			outConfigPath,
			outMainBootstrapConfigPath: bootstrapPath,
		})

		const runtimeConfig = parseJsonc<{
			name?: string
			env?: {
				preview?: {
					name?: string
					durable_objects?: { bindings?: Array<Record<string, unknown>> }
					d1_databases?: Array<Record<string, unknown>>
					queues?: { producers?: Array<Record<string, unknown>> }
					routes?: unknown
					vars?: Record<string, unknown>
					workflows?: Array<Record<string, unknown>>
				}
			}
		}>(await readFile(outConfigPath, 'utf8'))

		expect(runtimeConfig.name).toBe('kody-pr-7-runtime')
		expect(runtimeConfig.env?.preview?.name).toBe('kody-pr-7-runtime')
		const previewEnv = runtimeConfig.env?.preview
		// Cross-script references point at the resolved main worker name.
		const userMeter = previewEnv?.durable_objects?.bindings?.find(
			(binding) => binding.name === 'USER_METER',
		)
		expect(userMeter?.script_name).toBe('kody-pr-7')
		// Resource identifiers are copied from the provisioned main config.
		expect(previewEnv?.d1_databases?.[0]).toMatchObject({
			binding: 'APP_DB',
			database_name: 'kody-pr-7-db',
			database_id: 'd1-app-id',
		})
		expect(previewEnv?.queues?.producers?.[0]).toMatchObject({
			binding: 'WEBHOOK_DISPATCH_QUEUE',
			queue: 'kody-pr-7-webhook-dispatch',
		})
		// The workflow gets a per-worker name.
		expect(previewEnv?.workflows?.[0]?.name).toBe(
			'kody-pr-7-runtime-dynamic-callable-workflows',
		)
		// Preview has no package-app domain, so no routes are published.
		expect(previewEnv?.routes).toBeUndefined()
		// The main worker's resolved vars are merged in.
		expect(previewEnv?.vars?.APP_BASE_URL).toBe(
			'https://kody-pr-7.example.workers.dev',
		)

		// The main config was patched in place to reference the resolved
		// runtime worker name.
		const patchedMain = parseJsonc<{
			env?: {
				preview?: {
					services?: Array<Record<string, unknown>>
					durable_objects?: { bindings?: Array<Record<string, unknown>> }
				}
			}
		}>(await readFile(mainConfigPath, 'utf8'))
		expect(patchedMain.env?.preview?.services?.[0]?.service).toBe(
			'kody-pr-7-runtime',
		)

		// The bootstrap config has no runtime references: the service binding
		// is dropped and cross-script Durable Objects become local.
		const bootstrap = parseJsonc<{
			env?: {
				preview?: {
					services?: Array<Record<string, unknown>>
					durable_objects?: { bindings?: Array<Record<string, unknown>> }
					workflows?: Array<Record<string, unknown>>
				}
			}
		}>(await readFile(bootstrapPath, 'utf8'))
		expect(bootstrap.env?.preview?.services).toEqual([
			{ binding: 'JOBS', service: 'kody-pr-7-jobs', entrypoint: 'JobsService' },
		])
		const bootstrapStorageRunner =
			bootstrap.env?.preview?.durable_objects?.bindings?.find(
				(binding) => binding.name === 'STORAGE_RUNNER',
			)
		expect(bootstrapStorageRunner?.script_name).toBeUndefined()
		expect(bootstrap.env?.preview?.workflows?.[0]).toMatchObject({
			name: 'kody-pr-7-bootstrap-dynamic-callable-workflows',
		})
		expect(bootstrap.env?.preview?.workflows?.[0]?.script_name).toBeUndefined()
	} finally {
		await rm(tempDir, { force: true, recursive: true })
	}
})

test('generate publishes the package-app custom domain for production', async () => {
	consoleError.mockImplementation(() => {})
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-runtime-prod-'))
	try {
		const mainConfigPath = path.join(tempDir, 'main.generated.json')
		await writeFile(
			mainConfigPath,
			JSON.stringify(buildMainGeneratedConfig('production')),
		)
		const outConfigPath = path.join(tempDir, 'runtime.generated.json')

		await generate({
			envName: 'production',
			mainConfigPath,
			runtimeWorkerName: 'kody-runtime',
			mainWorkerName: 'kody',
			baseConfigPath: runtimeBaseConfigPath,
			outConfigPath,
		})

		const runtimeConfig = parseJsonc<{
			env?: {
				production?: {
					name?: string
					routes?: Array<{
						pattern: string
						custom_domain?: boolean
						zone_name?: string
					}>
					workers_dev?: boolean
					migrations?: unknown
				}
			}
			migrations?: Array<{ tag?: string; transferred_classes?: unknown }>
		}>(await readFile(outConfigPath, 'utf8'))

		// Both package-app routes are zone routes, never custom domains: a
		// custom domain in a zone whose route table the deploy also publishes
		// gets detached (deleting its DNS record) when the routes are replaced.
		expect(runtimeConfig.env?.production?.routes).toEqual([
			{ pattern: 'kodyapps.dev/*', zone_name: 'kodyapps.dev' },
			{ pattern: '*.kodyapps.dev/*', zone_name: 'kodyapps.dev' },
		])
		expect(runtimeConfig.env?.production?.name).toBe('kody-runtime')
		expect(runtimeConfig.env?.production?.workers_dev).toBe(true)
		// The storage transfer migration survives generation untouched.
		expect(runtimeConfig.migrations?.[0]?.tag).toBe('v1')
		expect(
			Array.isArray(runtimeConfig.migrations?.[0]?.transferred_classes),
		).toBe(true)
	} finally {
		await rm(tempDir, { force: true, recursive: true })
	}
})
