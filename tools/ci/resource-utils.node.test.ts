import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'

import {
	parseJsonc,
	parseR2BucketListOutput,
	writeGeneratedWranglerConfig,
} from './resource-utils.ts'

const thisDir = path.dirname(fileURLToPath(import.meta.url))
const workerWranglerConfigPath = path.resolve(
	thisDir,
	'../../packages/worker/wrangler.jsonc',
)

test('writeGeneratedWranglerConfig preserves migrations and copies environment asset routing', async () => {
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
			oauthKvId: 'dry-run-kody-oauth',
			bundleArtifactsKvId: 'dry-run-kody-bundle-artifacts',
			emailBlobsBucketName: 'kody-email-blobs',
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
					r2_buckets?: Array<{ binding: string; bucket_name: string }>
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
		expect(productionConfig.env?.production?.r2_buckets).toEqual([
			{ binding: 'EMAIL_BLOBS', bucket_name: 'kody-email-blobs' },
		])

		const previewOutPath = path.join(tempDir, 'wrangler-preview.generated.json')
		await writeGeneratedWranglerConfig({
			baseConfigPath: workerWranglerConfigPath,
			outConfigPath: previewOutPath,
			envName: 'preview',
			workerName: 'kody-pr-123',
			d1DatabaseName: 'kody-pr-123-db',
			d1DatabaseId: 'dry-run-kody-pr-123-db',
			oauthKvId: 'dry-run-kody-pr-123-oauth',
			bundleArtifactsKvId: 'dry-run-kody-pr-123-bundle-artifacts',
			emailBlobsBucketName: 'kody-pr-123-email-blobs',
		})

		const previewConfig = parseJsonc<{
			assets?: { run_worker_first?: Array<string> }
			env?: {
				preview?: {
					assets?: { run_worker_first?: Array<string> }
					r2_buckets?: Array<{ binding: string; bucket_name: string }>
				}
			}
		}>(await readFile(previewOutPath, 'utf8'))
		expect(previewConfig.assets).toEqual(previewConfig.env?.preview?.assets)
		expect(previewConfig.assets?.run_worker_first?.length).toBeGreaterThan(0)
		// The preview R2 bucket name is overridden per preview deploy.
		expect(previewConfig.env?.preview?.r2_buckets).toEqual([
			{ binding: 'EMAIL_BLOBS', bucket_name: 'kody-pr-123-email-blobs' },
		])
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
				oauthKvId: 'dry-run-kody-oauth',
				bundleArtifactsKvId: 'dry-run-kody-bundle-artifacts',
				emailBlobsBucketName: 'kody-email-blobs',
			}),
		).rejects.toThrow('process.exit')
		expect(error).toHaveBeenCalledWith(
			`wrangler config "${baseConfigPath}" is missing "env.production.assets".`,
		)
	} finally {
		exit.mockRestore()
		error.mockRestore()
		await rm(tempDir, { force: true, recursive: true })
	}
})
