import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

import { parseJsonc, writeGeneratedWranglerConfig } from './resource-utils.ts'

const thisDir = path.dirname(fileURLToPath(import.meta.url))
const workerWranglerConfigPath = path.resolve(
	thisDir,
	'../../packages/worker/wrangler.jsonc',
)

test('writeGeneratedWranglerConfig keeps migrations ordered by tag version', async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-resource-utils-'))

	try {
		const outConfigPath = path.join(
			tempDir,
			'wrangler-production.generated.json',
		)
		await writeGeneratedWranglerConfig({
			baseConfigPath: workerWranglerConfigPath,
			outConfigPath,
			envName: 'production',
			d1DatabaseName: 'kody',
			d1DatabaseId: 'dry-run-kody',
			oauthKvId: 'dry-run-kody-oauth',
			bundleArtifactsKvId: 'dry-run-kody-bundle-artifacts',
			extraMigrations: [
				{
					deleted_classes: ['AppRunner'],
					tag: 'v12',
				},
			],
		})

		const generatedConfigText = await readFile(outConfigPath, 'utf8')
		const generatedConfig = parseJsonc<{
			migrations: Array<{ tag: string; new_sqlite_classes?: Array<string> }>
		}>(generatedConfigText)
		const migrationTags = generatedConfig.migrations.map(
			(migration) => migration.tag,
		)
		const v12Index = migrationTags.indexOf('v12')
		const v13Index = migrationTags.indexOf('v13')

		expect(v12Index).toBeGreaterThanOrEqual(0)
		expect(v13Index).toBeGreaterThan(v12Index)
		expect(generatedConfig.migrations[v13Index]?.new_sqlite_classes).toContain(
			'PackageRealtimeSession',
		)
	} finally {
		await rm(tempDir, { force: true, recursive: true })
	}
})

test('writeGeneratedWranglerConfig copies production asset routing to the deployed top-level config', async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-resource-utils-'))

	try {
		const outConfigPath = path.join(
			tempDir,
			'wrangler-production.generated.json',
		)
		await writeGeneratedWranglerConfig({
			baseConfigPath: workerWranglerConfigPath,
			outConfigPath,
			envName: 'production',
			d1DatabaseName: 'kody',
			d1DatabaseId: 'dry-run-kody',
			oauthKvId: 'dry-run-kody-oauth',
			bundleArtifactsKvId: 'dry-run-kody-bundle-artifacts',
		})

		const generatedConfigText = await readFile(outConfigPath, 'utf8')
		const generatedConfig = parseJsonc<{
			assets?: { run_worker_first?: Array<string> }
			env?: {
				production?: { assets?: { run_worker_first?: Array<string> } }
			}
		}>(generatedConfigText)

		expect(generatedConfig.assets?.run_worker_first).toContain('/connectors/*')
		expect(generatedConfig.assets).toEqual(
			generatedConfig.env?.production?.assets,
		)
	} finally {
		await rm(tempDir, { force: true, recursive: true })
	}
})

test('writeGeneratedWranglerConfig copies preview asset routing to the deployed top-level config', async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-resource-utils-'))

	try {
		const outConfigPath = path.join(tempDir, 'wrangler-preview.generated.json')
		await writeGeneratedWranglerConfig({
			baseConfigPath: workerWranglerConfigPath,
			outConfigPath,
			envName: 'preview',
			workerName: 'kody-pr-123',
			d1DatabaseName: 'kody-pr-123-db',
			d1DatabaseId: 'dry-run-kody-pr-123-db',
			oauthKvId: 'dry-run-kody-pr-123-oauth',
			bundleArtifactsKvId: 'dry-run-kody-pr-123-bundle-artifacts',
		})

		const generatedConfigText = await readFile(outConfigPath, 'utf8')
		const generatedConfig = parseJsonc<{
			assets?: { run_worker_first?: Array<string> }
			env?: {
				preview?: { assets?: { run_worker_first?: Array<string> } }
			}
		}>(generatedConfigText)

		expect(generatedConfig.assets?.run_worker_first).toContain('/connectors/*')
		expect(generatedConfig.assets).toEqual(generatedConfig.env?.preview?.assets)
	} finally {
		await rm(tempDir, { force: true, recursive: true })
	}
})
