import { expect, test } from 'vitest'
import {
	buildSpawnEnv,
	buildWranglerSecretBulkFlags,
} from './sync-worker-secrets'

const baseOptions = {
	env: undefined,
	name: undefined,
	config: undefined,
	dotenvPaths: [],
	setPairs: [],
	setFromEnv: [],
	setFromEnvOptional: [],
	generateCookieSecret: false,
	includeEmpty: false,
	emptyAsSpace: false,
}

test('buildSpawnEnv preserves optional vars only when they have values', () => {
	const options = {
		...baseOptions,
		setFromEnvOptional: ['CLOUDFLARE_API_BASE_URL', 'SENTRY_DSN'],
	}
	const spawnEnvWithoutOptionalValues = buildSpawnEnv(options, {
		CLOUDFLARE_API_BASE_URL: '',
		COOKIE_SECRET: 'cookie',
		PATH: '/usr/bin',
		SENTRY_DSN: '',
	})
	expect(spawnEnvWithoutOptionalValues.CLOUDFLARE_API_BASE_URL).toBeUndefined()
	expect(spawnEnvWithoutOptionalValues.COOKIE_SECRET).toBe('cookie')
	expect(spawnEnvWithoutOptionalValues.PATH).toBe('/usr/bin')
	expect(spawnEnvWithoutOptionalValues.SENTRY_DSN).toBeUndefined()

	const spawnEnvWithOptionalValues = buildSpawnEnv(options, {
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com',
		PATH: '/usr/bin',
		SENTRY_DSN: 'https://examplePublicKey@o0.ingest.sentry.io/0',
	})
	expect(spawnEnvWithOptionalValues.CLOUDFLARE_API_BASE_URL).toBe(
		'https://api.cloudflare.com',
	)
	expect(spawnEnvWithOptionalValues.PATH).toBe('/usr/bin')
	expect(spawnEnvWithOptionalValues.SENTRY_DSN).toBe(
		'https://examplePublicKey@o0.ingest.sentry.io/0',
	)
})

test('secret bulk omits empty --env so --name pins the unsuffixed script', () => {
	const secretsFile = '/tmp/wrangler-secrets.env'
	expect(
		buildWranglerSecretBulkFlags(
			{
				...baseOptions,
				env: '',
				name: 'kody-runtime',
				config: 'packages/runtime-worker/wrangler-production.generated.json',
			},
			secretsFile,
		),
	).toEqual([
		'secret',
		'bulk',
		secretsFile,
		'--name',
		'kody-runtime',
		'--config',
		'packages/runtime-worker/wrangler-production.generated.json',
	])

	expect(
		buildWranglerSecretBulkFlags(
			{
				...baseOptions,
				env: 'production',
				config: 'packages/worker/wrangler-production.generated.json',
			},
			secretsFile,
		),
	).toEqual([
		'secret',
		'bulk',
		secretsFile,
		'--env',
		'production',
		'--config',
		'packages/worker/wrangler-production.generated.json',
	])
})
