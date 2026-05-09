import { expect, test } from 'vitest'
import {
	hasRemoteConnectorSharedSecret,
	remoteConnectorSharedSecretMatches,
	resolveRemoteConnectorSharedSecret,
} from './resolve-remote-connector-secret.ts'

function createEmptyRemoteConnectorSettingsDb() {
	return {
		prepare: () => ({
			bind: () => ({
				all: async () => ({ results: [], meta: { changes: 0 } }),
			}),
		}),
	} as unknown as D1Database
}

test('remote connector shared secrets are not read from environment variables', async () => {
	const env = {
		APP_DB: createEmptyRemoteConnectorSettingsDb(),
		SECRET_STORE_KEY: 'x'.repeat(32),
		REMOTE_CONNECTOR_SECRETS: {
			'custom:alpha': 'alpha-secret',
			'lights:default': 'lights-secret',
		},
	} as Env

	await expect(
		resolveRemoteConnectorSharedSecret({
			env,
			userId: 'user-aaa',
			kind: 'custom',
			instanceId: 'alpha',
		}),
	).resolves.toBeUndefined()
	await expect(
		remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-aaa',
			kind: 'custom',
			instanceId: 'alpha',
			sharedSecret: 'alpha-secret',
		}),
	).resolves.toBe(false)
	await expect(
		hasRemoteConnectorSharedSecret({
			env,
			userId: 'user-aaa',
			kind: 'lights',
			instanceId: 'default',
		}),
	).resolves.toBe(false)
})
