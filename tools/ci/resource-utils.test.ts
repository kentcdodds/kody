import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { writeGeneratedWranglerConfig } from './resource-utils'

const tempDirs: Array<string> = []

afterEach(async () => {
	await Promise.all(
		tempDirs.map(async (dir) => {
			await rm(dir, { recursive: true, force: true })
		}),
	)
	tempDirs.length = 0
})

test('writeGeneratedWranglerConfig preserves vars and adds APP_BASE_URL', async () => {
	const tempDir = await mkdtemp(path.join(tmpdir(), 'resource-utils-test-'))
	tempDirs.push(tempDir)

	const baseConfigPath = path.join(tempDir, 'wrangler.jsonc')
	const outConfigPath = path.join(tempDir, 'wrangler.generated.json')

	await writeFile(
		baseConfigPath,
		JSON.stringify(
			{
				name: 'kody',
				env: {
					production: {
						d1_databases: [
							{
								binding: 'APP_DB',
								database_name: 'kody',
							},
						],
						kv_namespaces: [
							{
								binding: 'OAUTH_KV',
							},
						],
						vars: {
							AI_MODE: 'remote',
						},
					},
				},
			},
			null,
			'\t',
		),
		'utf8',
	)

	await writeGeneratedWranglerConfig({
		baseConfigPath,
		outConfigPath,
		envName: 'production',
		d1DatabaseName: 'kody',
		d1DatabaseId: 'db-id',
		oauthKvId: 'kv-id',
		workerVars: {
			APP_BASE_URL: 'https://heykody.dev/',
		},
	})

	const outputText = await readFile(outConfigPath, 'utf8')
	const output = JSON.parse(outputText) as {
		env: {
			production: {
				d1_databases: Array<Record<string, string>>
				kv_namespaces: Array<Record<string, string>>
				vars: Record<string, string>
			}
		}
	}

	expect(output.env.production.d1_databases[0]).toMatchObject({
		binding: 'APP_DB',
		database_name: 'kody',
		database_id: 'db-id',
	})
	expect(output.env.production.kv_namespaces[0]).toMatchObject({
		binding: 'OAUTH_KV',
		id: 'kv-id',
		preview_id: 'kv-id',
	})
	expect(output.env.production.vars).toEqual({
		AI_MODE: 'remote',
		APP_BASE_URL: 'https://heykody.dev/',
	})
})
