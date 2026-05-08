import { expect, test } from 'vitest'
import { parseSafe } from 'remix/data-schema'
import { EnvSchema } from './env-schema.ts'

function createBaseEnv(remoteConnectorSecrets: unknown) {
	return {
		COOKIE_SECRET: 'c'.repeat(32),
		SECRET_STORE_KEY: 's'.repeat(32),
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		JOB_MANAGER: {},
		STORAGE_RUNNER: {},
		PACKAGE_REALTIME_SESSION: {},
		PACKAGE_SERVICE_INSTANCE: {},
		REMOTE_CONNECTOR_SECRETS: remoteConnectorSecrets,
	}
}

test('REMOTE_CONNECTOR_SECRETS validation is idempotent after parsing JSON', () => {
	const first = parseSafe(
		EnvSchema,
		createBaseEnv(
			JSON.stringify({
				'HOME:default': ' home-secret ',
			}),
		),
	)

	expect(first.success).toBe(true)
	if (!first.success) return
	expect(first.value.REMOTE_CONNECTOR_SECRETS).toEqual({
		'home:default': 'home-secret',
	})

	const second = parseSafe(EnvSchema, first.value)

	expect(second.success).toBe(true)
	if (!second.success) return
	expect(second.value.REMOTE_CONNECTOR_SECRETS).toEqual({
		'home:default': 'home-secret',
	})
})
