import { expect, test } from 'vitest'
import { buildSpawnEnv } from './sync-worker-secrets'

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
