import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'

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

test('writeGeneratedWranglerConfig fails when package workflows binding is missing', async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-resource-utils-'))

	try {
		const baseConfigPath = path.join(tempDir, 'wrangler.jsonc')
		const outConfigPath = path.join(tempDir, 'wrangler-preview.generated.json')
		await writeFile(
			baseConfigPath,
			JSON.stringify(
				{
					name: 'kody',
					env: {
						preview: {
							d1_databases: [{ binding: 'APP_DB' }],
							kv_namespaces: [
								{ binding: 'OAUTH_KV' },
								{ binding: 'BUNDLE_ARTIFACTS_KV' },
							],
							workflows: [
								{
									binding: 'OTHER_WORKFLOW',
									name: 'other-workflow',
								},
							],
						},
					},
					migrations: [],
				},
				null,
				2,
			),
		)

		const consoleErrorSpy = vi
			.spyOn(console, 'error')
			.mockImplementation(() => undefined)
		const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit')
		})

		try {
			await expect(
				writeGeneratedWranglerConfig({
					baseConfigPath,
					outConfigPath,
					envName: 'preview',
					workerName: 'kody-pr-123',
					d1DatabaseName: 'kody-pr-123-db',
					d1DatabaseId: 'dry-run-db',
					oauthKvId: 'dry-run-oauth',
					bundleArtifactsKvId: 'dry-run-bundle',
				}),
			).rejects.toThrow('process.exit')
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'has no preview workflow binding for "PACKAGE_WORKFLOWS"',
				),
			)
		} finally {
			processExitSpy.mockRestore()
			consoleErrorSpy.mockRestore()
		}
	} finally {
		await rm(tempDir, { force: true, recursive: true })
	}
})
