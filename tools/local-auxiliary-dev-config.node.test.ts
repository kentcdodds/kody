import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { writeLocalAuxiliaryDevConfig } from './local-auxiliary-dev-config.ts'

test('pins the registered name and rewrites HOST to the origin dev name', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'auxiliary-dev-config-'))
	try {
		const configPath = path.join(dir, 'wrangler.jsonc')
		await writeFile(
			configPath,
			JSON.stringify({
				name: 'kody-jobs',
				main: './src/index.ts',
				migrations: [
					{
						tag: 'v1',
						transferred_classes: [
							{
								from: 'JobManager',
								from_script: 'kody-production',
								to: 'JobManager',
							},
						],
					},
				],
				env: {
					production: {
						services: [
							{
								binding: 'HOST',
								service: 'kody-production',
								entrypoint: 'JobsHost',
							},
						],
						vars: { SENTRY_ENVIRONMENT: 'production' },
					},
				},
			}),
		)
		const outputPath = await writeLocalAuxiliaryDevConfig({
			configPath,
			envName: 'production',
			mainWorkerDevName: 'kody-production',
		})
		expect(path.basename(outputPath)).toBe('wrangler-local-dev.generated.json')
		const written = JSON.parse(await readFile(outputPath, 'utf8')) as {
			migrations: Array<{ new_sqlite_classes?: Array<string> }>
			env: {
				production: {
					name: string
					services: Array<{
						binding: string
						service: string
						entrypoint: string
					}>
					vars: Record<string, string>
				}
			}
		}
		expect(written.env.production.name).toBe('kody-jobs')
		expect(written.env.production.services).toEqual([
			{
				binding: 'HOST',
				service: 'kody-production',
				entrypoint: 'JobsHost',
			},
		])
		expect(written.env.production.vars.WRANGLER_IS_LOCAL_DEV).toBe('true')
		expect(written.migrations).toEqual([
			{ tag: 'v1', new_sqlite_classes: ['JobManager'] },
		])
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('does not pin the registered name in the test env', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'auxiliary-dev-config-test-'))
	try {
		const configPath = path.join(dir, 'wrangler.jsonc')
		await writeFile(
			configPath,
			JSON.stringify({
				name: 'kody-jobs',
				main: './src/index.ts',
				env: {
					test: {
						services: [
							{
								binding: 'HOST',
								service: 'kody-test',
								entrypoint: 'JobsHost',
							},
						],
						vars: { SENTRY_ENVIRONMENT: 'test' },
					},
				},
			}),
		)
		const outputPath = await writeLocalAuxiliaryDevConfig({
			configPath,
			envName: 'test',
			mainWorkerDevName: 'kody-test',
		})
		const written = JSON.parse(await readFile(outputPath, 'utf8')) as {
			env: { test: { name?: string; services: Array<{ service: string }> } }
		}
		expect(written.env.test.name).toBeUndefined()
		expect(written.env.test.services[0]?.service).toBe('kody-test')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
