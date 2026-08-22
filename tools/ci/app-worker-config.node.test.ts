import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { generate } from './app-worker-config.ts'
import { parseJsonc } from './resource-utils.ts'

const appBaseConfigPath = 'packages/app-worker/wrangler.jsonc'

test('app-surface worker owns no Durable Object classes', async () => {
	const config = parseJsonc<{
		migrations?: unknown
		env?: Record<
			string,
			{ durable_objects?: { bindings?: Array<Record<string, unknown>> } }
		>
	}>(await readFile(appBaseConfigPath, 'utf8'))
	expect(config.migrations).toBeUndefined()
	for (const envName of ['production', 'preview']) {
		const bindings = config.env?.[envName]?.durable_objects?.bindings ?? []
		expect(bindings.length).toBeGreaterThan(0)
		for (const binding of bindings) {
			expect(binding.script_name).toBeTruthy()
		}
	}
})

function buildMainGeneratedConfig() {
	return {
		name: 'kody-pr-7',
		env: {
			preview: {
				services: [
					{ binding: 'RUNTIME_WORKER', service: 'kody-pr-7-runtime' },
					{
						binding: 'JOBS',
						service: 'kody-pr-7-jobs',
						entrypoint: 'JobsService',
					},
					{ binding: 'APP_SURFACE', service: 'kody-app' },
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
					{ binding: 'OAUTH_KV', id: 'kv-oauth', title: 'oauth' },
					{
						binding: 'BUNDLE_ARTIFACTS_KV',
						id: 'kv-bundle',
						title: 'bundle',
					},
				],
				r2_buckets: [
					{
						binding: 'COMMUNITY_ASSETS',
						bucket_name: 'kody-pr-7-community-assets',
					},
					{ binding: 'EMAIL_BLOBS', bucket_name: 'kody-pr-7-email-blobs' },
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
					],
				},
				analytics_engine_datasets: [
					{ binding: 'USAGE_EVENTS', dataset: 'usage' },
					{ binding: 'FLAG_EXPOSURES', dataset: 'flags' },
					{ binding: 'EMAIL_EVENTS', dataset: 'email' },
				],
				vars: {
					APP_BASE_URL: 'https://kody-pr-7.example',
					SIGNUP_MODE: 'invite',
				},
			},
		},
	}
}

test('app-worker config copies resource ids and pins APP_SURFACE on main', async () => {
	consoleError.mockImplementation(() => {})
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'app-worker-config-'))
	try {
		const mainConfigPath = path.join(tempDir, 'main.json')
		const outConfigPath = path.join(tempDir, 'app.json')
		const bootstrapPath = path.join(tempDir, 'bootstrap.json')
		await writeFile(mainConfigPath, JSON.stringify(buildMainGeneratedConfig()))
		await generate({
			envName: 'preview',
			mainConfigPath,
			appWorkerName: 'kody-pr-7-app',
			runtimeWorkerName: 'kody-pr-7-runtime',
			mainWorkerName: 'kody-pr-7',
			jobsWorkerName: 'kody-pr-7-jobs',
			baseConfigPath: appBaseConfigPath,
			outConfigPath,
			outMainBootstrapConfigPath: bootstrapPath,
		})

		const appConfig = parseJsonc<{
			name?: string
			env?: Record<string, { name?: string; d1_databases?: Array<unknown> }>
		}>(await readFile(outConfigPath, 'utf8'))
		expect(appConfig.name).toBe('kody-pr-7-app')
		expect(appConfig.env?.preview?.name).toBe('kody-pr-7-app')

		const patchedMain = parseJsonc<{
			env?: Record<string, { services?: Array<Record<string, unknown>> }>
		}>(await readFile(mainConfigPath, 'utf8'))
		expect(
			patchedMain.env?.preview?.services?.find(
				(entry) => entry.binding === 'APP_SURFACE',
			)?.service,
		).toBe('kody-pr-7-app')

		const bootstrap = parseJsonc<{
			env?: Record<string, { services?: Array<Record<string, unknown>> }>
		}>(await readFile(bootstrapPath, 'utf8'))
		expect(
			bootstrap.env?.preview?.services?.some(
				(entry) => entry.binding === 'APP_SURFACE',
			),
		).toBe(false)
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})
