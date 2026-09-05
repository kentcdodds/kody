import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

import { generate } from './platform-worker-config.ts'
import { parseJsonc } from './resource-utils.ts'

const platformBaseConfigPath = 'packages/platform-worker/wrangler.jsonc'

test('platform worker owns remaining classes and binds runtime DOs cross-script', async () => {
	const config = parseJsonc<{
		migrations?: Array<{ transferred_classes?: Array<Record<string, unknown>> }>
		env?: Record<
			string,
			{
				durable_objects?: { bindings?: Array<Record<string, unknown>> }
				send_email?: Array<Record<string, unknown>>
				artifacts?: Array<Record<string, unknown>>
			}
		>
	}>(await readFile(platformBaseConfigPath, 'utf8'))
	expect(config.migrations?.[0]?.transferred_classes).toEqual(
		expect.arrayContaining([
			{ from: 'MCP', from_script: 'kody', to: 'MCP' },
			{ from: 'UserMeter', from_script: 'kody', to: 'UserMeter' },
			{ from: 'Mailbox', from_script: 'kody', to: 'Mailbox' },
			{ from: 'RepoSession', from_script: 'kody', to: 'RepoSession' },
		]),
	)
	for (const envName of ['production', 'preview']) {
		const env = config.env?.[envName]
		const bindings = env?.durable_objects?.bindings ?? []
		const mcp = bindings.find((binding) => binding.name === 'MCP_OBJECT')
		const storageRunner = bindings.find(
			(binding) => binding.name === 'STORAGE_RUNNER',
		)
		expect(mcp).toMatchObject({ class_name: 'MCP' })
		expect(mcp?.script_name).toBeUndefined()
		expect(storageRunner).toMatchObject({
			class_name: 'StorageRunner',
			script_name: 'kody-runtime',
		})
		expect(env?.send_email).toEqual([{ name: 'EMAIL' }])
		expect(env?.artifacts?.[0]).toMatchObject({
			binding: 'ARTIFACTS',
			namespace: envName === 'production' ? 'production' : 'preview',
		})
	}
})

function buildMainGeneratedConfig(envName: string) {
	const env = {
		durable_objects: {
			bindings: [
				{
					name: 'MCP_OBJECT',
					class_name: 'MCP',
					script_name: 'kody-platform',
				},
				{
					name: 'USER_METER',
					class_name: 'UserMeter',
					script_name: 'kody-platform',
				},
				{
					name: 'STORAGE_RUNNER',
					class_name: 'StorageRunner',
					script_name: 'kody-runtime',
				},
			],
		},
		services: [
			{ binding: 'RUNTIME_WORKER', service: 'kody-runtime' },
			{ binding: 'JOBS', service: 'kody-pr-7-jobs', entrypoint: 'JobsService' },
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
			{
				binding: 'REPO_SESSION_BLOBS',
				bucket_name: 'kody-pr-7-repo-session-blobs',
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
								binding: 'COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE',
								queue: 'kody-community-listing-published-dispatch',
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
			{ binding: 'EMAIL_EVENTS', dataset: 'kody_email_events_pr' },
			{
				binding: 'MCP_PROTOCOL_EVENTS',
				dataset: 'kody_mcp_protocol_events_pr',
			},
			{
				binding: 'PACKAGE_INVOKE_SPECIFIER_EVENTS',
				dataset: 'kody_package_invoke_specifier_events_pr',
			},
			{
				binding: 'EXECUTE_INTERPRETABLE_EVENTS',
				dataset: 'kody_execute_interpretable_events_pr',
			},
		],
		vars: {
			APP_BASE_URL: 'https://kody-pr-7.example.workers.dev',
		},
	}
	return { name: 'kody', env: { [envName]: env } }
}

test('generate rewrites worker names, copies resource ids, and writes a bootstrap config', async () => {
	consoleError.mockImplementation(() => {})
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-platform-config-'))
	try {
		const mainConfigPath = path.join(tempDir, 'main.generated.json')
		await writeFile(
			mainConfigPath,
			JSON.stringify(buildMainGeneratedConfig('preview')),
		)
		const outConfigPath = path.join(tempDir, 'platform.generated.json')
		const platformBootstrapPath = path.join(
			tempDir,
			'platform-bootstrap.generated.json',
		)

		await generate({
			envName: 'preview',
			mainConfigPath,
			platformWorkerName: 'kody-pr-7-platform',
			runtimeWorkerName: 'kody-pr-7-runtime',
			mainWorkerName: 'kody-pr-7',
			baseConfigPath: platformBaseConfigPath,
			outConfigPath,
			outPlatformBootstrapConfigPath: platformBootstrapPath,
		})

		const platformConfig = parseJsonc<{
			name?: string
			env?: {
				preview?: {
					name?: string
					workers_dev?: boolean
					durable_objects?: { bindings?: Array<Record<string, unknown>> }
					d1_databases?: Array<Record<string, unknown>>
					analytics_engine_datasets?: Array<Record<string, unknown>>
					queues?: { producers?: Array<Record<string, unknown>> }
					vars?: Record<string, unknown>
					workflows?: Array<Record<string, unknown>>
					services?: Array<Record<string, unknown>>
				}
			}
		}>(await readFile(outConfigPath, 'utf8'))

		expect(platformConfig.name).toBe('kody-pr-7-platform')
		expect(platformConfig.env?.preview?.name).toBe('kody-pr-7-platform')
		expect(platformConfig.env?.preview?.workers_dev).toBe(true)
		const previewEnv = platformConfig.env?.preview
		expect(
			previewEnv?.durable_objects?.bindings?.find(
				(binding) => binding.name === 'STORAGE_RUNNER',
			)?.script_name,
		).toBe('kody-pr-7-runtime')
		expect(previewEnv?.d1_databases?.[0]).toMatchObject({
			binding: 'APP_DB',
			database_name: 'kody-pr-7-db',
			database_id: 'd1-app-id',
		})
		expect(
			previewEnv?.analytics_engine_datasets?.find(
				(entry) => entry.binding === 'PACKAGE_INVOKE_SPECIFIER_EVENTS',
			),
		).toEqual({
			binding: 'PACKAGE_INVOKE_SPECIFIER_EVENTS',
			dataset: 'kody_package_invoke_specifier_events_pr',
		})
		expect(
			previewEnv?.analytics_engine_datasets?.find(
				(entry) => entry.binding === 'EXECUTE_INTERPRETABLE_EVENTS',
			),
		).toEqual({
			binding: 'EXECUTE_INTERPRETABLE_EVENTS',
			dataset: 'kody_execute_interpretable_events_pr',
		})
		expect(previewEnv?.queues?.producers?.[0]).toMatchObject({
			binding: 'WEBHOOK_DISPATCH_QUEUE',
			queue: 'kody-pr-7-webhook-dispatch',
		})
		expect(previewEnv?.workflows?.[0]?.name).toBe(
			'kody-pr-7-runtime-dynamic-callable-workflows',
		)
		expect(previewEnv?.vars?.APP_BASE_URL).toBe(
			'https://kody-pr-7.example.workers.dev',
		)

		const patchedMain = parseJsonc<{
			env?: {
				preview?: {
					durable_objects?: { bindings?: Array<Record<string, unknown>> }
				}
			}
		}>(await readFile(mainConfigPath, 'utf8'))
		expect(
			patchedMain.env?.preview?.durable_objects?.bindings?.find(
				(binding) => binding.name === 'MCP_OBJECT',
			)?.script_name,
		).toBe('kody-pr-7-platform')

		// The bootstrap variant deploys before the runtime script exists, so
		// it carries no binding that resolves to it; platform-owned classes
		// and every other binding stay intact.
		const platformBootstrap = parseJsonc<{
			env?: {
				preview?: {
					durable_objects?: { bindings?: Array<Record<string, unknown>> }
					workflows?: Array<Record<string, unknown>>
					services?: Array<Record<string, unknown>>
				}
			}
		}>(await readFile(platformBootstrapPath, 'utf8'))
		const bootstrapBindings =
			platformBootstrap.env?.preview?.durable_objects?.bindings ?? []
		expect(
			bootstrapBindings.filter(
				(binding) => binding.script_name === 'kody-pr-7-runtime',
			),
		).toEqual([])
		expect(bootstrapBindings.map((binding) => binding.name)).toEqual(
			expect.arrayContaining(['MCP_OBJECT', 'USER_METER', 'REPO_SESSION']),
		)
		expect(bootstrapBindings).not.toContainEqual(
			expect.objectContaining({ name: 'STORAGE_RUNNER' }),
		)
		expect(platformBootstrap.env?.preview?.workflows).toEqual([])
		expect(platformBootstrap.env?.preview?.services).toEqual(
			previewEnv?.services,
		)
	} finally {
		await rm(tempDir, { force: true, recursive: true })
	}
})

test('generate rewrites the production transfer from_script to the main worker name', async () => {
	consoleError.mockImplementation(() => {})
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-platform-prod-'))
	try {
		const mainConfigPath = path.join(tempDir, 'main.generated.json')
		await writeFile(
			mainConfigPath,
			JSON.stringify(buildMainGeneratedConfig('production')),
		)
		const outConfigPath = path.join(tempDir, 'platform.generated.json')

		await generate({
			envName: 'production',
			mainConfigPath,
			platformWorkerName: 'kody-platform',
			runtimeWorkerName: 'kody-runtime',
			mainWorkerName: 'kody-production',
			baseConfigPath: platformBaseConfigPath,
			outConfigPath,
		})

		const platformConfig = parseJsonc<{
			migrations?: Array<{
				tag?: string
				transferred_classes?: Array<{ from_script?: string }>
			}>
			env?: { production?: { name?: string } }
		}>(await readFile(outConfigPath, 'utf8'))

		expect(platformConfig.env?.production?.name).toBe('kody-platform')
		expect(platformConfig.migrations?.[0]?.tag).toBe('v1')
		expect(
			platformConfig.migrations?.[0]?.transferred_classes?.every(
				(entry) => entry.from_script === 'kody-production',
			),
		).toBe(true)
	} finally {
		await rm(tempDir, { force: true, recursive: true })
	}
})
