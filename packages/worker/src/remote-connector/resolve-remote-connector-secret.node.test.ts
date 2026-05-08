import { expect, test } from 'vitest'
import { resolveRemoteConnectorSharedSecret } from './resolve-remote-connector-secret.ts'

function createEmptyRemoteConnectorSettingsDb() {
	return {
		prepare: () => ({
			bind: () => ({
				all: async () => ({ results: [], meta: { changes: 0 } }),
			}),
		}),
	} as unknown as D1Database
}

test('REMOTE_CONNECTOR_SECRETS resolves by kind and instance', async () => {
	const env = {
		APP_DB: createEmptyRemoteConnectorSettingsDb(),
		SECRET_STORE_KEY: 'x'.repeat(32),
		REMOTE_CONNECTOR_SECRETS: {
			'custom:alpha': 'alpha-secret',
			'lights:default': 'lights-secret',
		},
	} as Env
	await expect(
		resolveRemoteConnectorSharedSecret('custom', 'alpha', env),
	).resolves.toBe('alpha-secret')
	await expect(
		resolveRemoteConnectorSharedSecret('lights', 'default', env),
	).resolves.toBe('lights-secret')
})

test('returns undefined when the map does not contain the connector key', async () => {
	await expect(
		resolveRemoteConnectorSharedSecret('custom', 'alpha', {
			APP_DB: createEmptyRemoteConnectorSettingsDb(),
			SECRET_STORE_KEY: 'x'.repeat(32),
			REMOTE_CONNECTOR_SECRETS: {
				'lights:default': 'lights-secret',
			},
		} as Env),
	).resolves.toBeUndefined()
})

test('normalizes fallback connector keys generically', async () => {
	const env = {
		APP_DB: createEmptyRemoteConnectorSettingsDb(),
		SECRET_STORE_KEY: 'x'.repeat(32),
		REMOTE_CONNECTOR_SECRETS: {
			'roku:living-room': 'roku-secret',
		},
	} as Env
	await expect(
		resolveRemoteConnectorSharedSecret(' Roku ', ' living-room ', env),
	).resolves.toBe('roku-secret')
})
