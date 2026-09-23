import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { unstable_readConfig } from 'wrangler'
import { parseJsonc } from './ci/resource-utils.ts'
import { writeLocalJobsDevConfig } from './local-jobs-dev-config.ts'

const originConfigPath = 'packages/worker/wrangler.jsonc'
const committedJobsConfigPath = 'packages/jobs-worker/wrangler.jsonc'

test('local jobs dev config registers under the origin JOBS service name', async () => {
	const committed = parseJsonc<{
		name?: string
		env?: { production?: { name?: string } }
	}>(await readFile(committedJobsConfigPath, 'utf8'))
	expect(committed.name).toBe('kody-jobs')
	expect(committed.env?.production?.name).toBeUndefined()
	expect(
		unstable_readConfig({
			config: committedJobsConfigPath,
			env: 'production',
		}).name,
	).toBe('kody-jobs-production')

	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-local-jobs-'))
	const jobsConfigPath = path.join(tempDir, 'wrangler.jsonc')
	try {
		await writeFile(
			jobsConfigPath,
			await readFile(committedJobsConfigPath, 'utf8'),
		)

		const productionPath = await writeLocalJobsDevConfig({
			jobsConfigPath,
			originConfigPath,
			envName: 'production',
		})
		const production = parseJsonc<{
			name?: string
			env?: {
				production?: {
					name?: string
					services?: Array<{ binding?: string; service?: string }>
				}
			}
		}>(await readFile(productionPath, 'utf8'))
		expect(path.basename(productionPath)).toBe(
			'wrangler-local-dev.generated.json',
		)
		expect(production.name).toBe('kody-jobs')
		expect(production.env?.production?.name).toBe('kody-jobs')
		expect(production.env?.production?.name).toBe(
			jobsServiceName(await readOriginEnv('production')),
		)
		expect(
			unstable_readConfig({ config: productionPath, env: 'production' }).name,
		).toBe('kody-jobs')
		expect(hostService(production.env?.production?.services)).toBe(
			'kody-production',
		)

		const testPath = await writeLocalJobsDevConfig({
			jobsConfigPath,
			originConfigPath,
			envName: 'test',
		})
		const testConfig = parseJsonc<{
			env?: { test?: { name?: string } }
		}>(await readFile(testPath, 'utf8'))
		expect(testConfig.env?.test?.name).toBe('kody-jobs-test')
		expect(testConfig.env?.test?.name).toBe(
			jobsServiceName(await readOriginEnv('test')),
		)
		expect(unstable_readConfig({ config: testPath, env: 'test' }).name).toBe(
			'kody-jobs-test',
		)
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

async function readOriginEnv(envName: string) {
	const origin = parseJsonc<{
		env?: Record<
			string,
			{ services?: Array<{ binding?: string; service?: string }> }
		>
	}>(await readFile(originConfigPath, 'utf8'))
	const env = origin.env?.[envName]
	if (!env) throw new Error(`origin is missing env.${envName}`)
	return env
}

function jobsServiceName(env: {
	services?: Array<{ binding?: string; service?: string }>
}) {
	const service = env.services?.find(
		(entry) => entry.binding === 'JOBS',
	)?.service
	if (!service) throw new Error('origin JOBS service is missing')
	return service
}

function hostService(
	services: Array<{ binding?: string; service?: string }> | undefined,
) {
	return services?.find((entry) => entry.binding === 'HOST')?.service
}
