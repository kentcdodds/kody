import { expect, test } from 'vitest'
import { buildSpawnEnv, buildWranglerSecretPutArgs } from './sync-worker-secrets'

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
	putIndividually: false,
}

test('buildSpawnEnv removes empty optional vars', () => {
	const options = {
		...baseOptions,
		setFromEnvOptional: ['CLOUDFLARE_API_BASE_URL', 'SENTRY_DSN'],
	}
	const spawnEnv = buildSpawnEnv(options, {
		CLOUDFLARE_API_BASE_URL: '',
		COOKIE_SECRET: 'cookie',
		PATH: '/usr/bin',
		SENTRY_DSN: '',
	})

	expect(spawnEnv.CLOUDFLARE_API_BASE_URL).toBeUndefined()
	expect(spawnEnv.COOKIE_SECRET).toBe('cookie')
	expect(spawnEnv.PATH).toBe('/usr/bin')
	expect(spawnEnv.SENTRY_DSN).toBeUndefined()
})

test('buildSpawnEnv keeps optional vars when set', () => {
	const options = {
		...baseOptions,
		setFromEnvOptional: ['CLOUDFLARE_API_BASE_URL'],
	}
	const spawnEnv = buildSpawnEnv(options, {
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com',
		PATH: '/usr/bin',
	})

	expect(spawnEnv.CLOUDFLARE_API_BASE_URL).toBe('https://api.cloudflare.com')
	expect(spawnEnv.PATH).toBe('/usr/bin')
})

test('buildWranglerSecretPutArgs targets a worker by name without env config', () => {
	const args = buildWranglerSecretPutArgs(
		{
			...baseOptions,
			name: 'kody-production',
		},
		'COOKIE_SECRET',
	)

	expect(args.slice(1)).toEqual([
		'secret',
		'put',
		'COOKIE_SECRET',
		'--name',
		'kody-production',
	])
})

test('buildWranglerSecretPutArgs includes env and config when provided', () => {
	const args = buildWranglerSecretPutArgs(
		{
			...baseOptions,
			config: 'packages/worker/wrangler.jsonc',
			env: 'preview',
			name: 'kody-preview',
		},
		'COOKIE_SECRET',
	)

	expect(args.slice(1)).toEqual([
		'secret',
		'put',
		'COOKIE_SECRET',
		'--env',
		'preview',
		'--name',
		'kody-preview',
		'--config',
		'packages/worker/wrangler.jsonc',
	])
})
