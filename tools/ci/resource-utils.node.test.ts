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
