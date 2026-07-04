import { expect, test } from 'vitest'
import { getEnv } from './env.ts'
import { handleRequest } from './handler.ts'

function createEnv(overrides: Record<string, unknown> = {}) {
	return {
		COOKIE_SECRET: 'LOCAL_TEST_COOKIE_SECRET_32_CHARS_MINIMUM',
		SECRET_STORE_KEY: 'LOCAL_TEST_SECRET_STORE_KEY_32_CHARS_MINIMUM',
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		JOB_MANAGER: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		PACKAGE_SERVICE_INSTANCE: {},
		...overrides,
	} as unknown as Env
}

test('account secrets api ignores legacy remote connector env secrets', async () => {
	const response = await handleRequest(
		new Request('https://example.com/account/secrets.json'),
		createEnv({
			REMOTE_CONNECTOR_SECRETS: {
				'custom:alpha': 'alpha-secret',
			},
		}),
	)

	expect(response.status).toBe(401)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'Unauthorized.',
	})
})

test('getEnv memoizes the parsed env per env object identity', () => {
	const env = createEnv()
	expect(getEnv(env)).toBe(getEnv(env))
	expect(getEnv(createEnv())).not.toBe(getEnv(env))
})

test('handleRequest serves multiple requests from the same env object', async () => {
	const env = createEnv()
	const first = await handleRequest(
		new Request('https://example.com/health'),
		env,
	)
	const second = await handleRequest(
		new Request('https://example.com/health'),
		env,
	)

	expect(first.status).toBe(200)
	expect(second.status).toBe(200)
	await expect(second.json()).resolves.toMatchObject({ ok: true })
})
