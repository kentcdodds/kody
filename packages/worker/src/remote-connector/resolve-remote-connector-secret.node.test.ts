import { expect, test, vi } from 'vitest'
import {
	d1LockRetryBaseDelayMs,
	d1LockRetryMaxAttempts,
} from '#worker/d1-retry.ts'
import {
	hasRemoteConnectorSharedSecret,
	remoteConnectorSharedSecretMatches,
	resolveRemoteConnectorSharedSecret,
} from './resolve-remote-connector-secret.ts'

function createRemoteConnectorSettingsDb(input: {
	all: () => Promise<{ results: Array<Record<string, unknown>> }>
}) {
	return {
		prepare: () => ({
			bind: () => ({
				all: input.all,
			}),
		}),
	} as unknown as D1Database
}

function createEmptyRemoteConnectorSettingsDb() {
	return createRemoteConnectorSettingsDb({
		all: async () => ({ results: [] }),
	})
}

test('remote connector shared secrets are not read from environment variables', async () => {
	const env = {
		APP_DB: createEmptyRemoteConnectorSettingsDb(),
		SECRET_STORE_KEY: 'x'.repeat(32),
		REMOTE_CONNECTOR_SECRETS: {
			'custom:alpha': 'alpha-secret',
			'lights:lights': 'lights-secret',
		},
	} as Env

	await expect(
		resolveRemoteConnectorSharedSecret({
			env,
			userId: 'user-aaa',
			instanceId: 'alpha',
		}),
	).resolves.toBeUndefined()
	await expect(
		remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-aaa',
			instanceId: 'alpha',
			sharedSecret: 'alpha-secret',
		}),
	).resolves.toBe(false)
	await expect(
		hasRemoteConnectorSharedSecret({
			env,
			userId: 'user-aaa',
			instanceId: 'home',
		}),
	).resolves.toBe(false)
})

test('remote connector shared-secret reads retry transient D1 locks then succeed', async () => {
	const all = vi
		.fn()
		.mockRejectedValueOnce(
			new Error('D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY'),
		)
		.mockResolvedValueOnce({ results: [] })
	const env = {
		APP_DB: createRemoteConnectorSettingsDb({ all }),
		SECRET_STORE_KEY: 'x'.repeat(32),
	} as Env

	vi.useFakeTimers()
	try {
		const resultPromise = remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-aaa',
			instanceId: 'home',
			sharedSecret: 'home-secret',
		})
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(resultPromise).resolves.toBe(false)
		expect(all).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}
})

test('remote connector shared-secret reads propagate non-retryable D1 failures', async () => {
	const all = vi
		.fn()
		.mockRejectedValue(new Error('D1_ERROR: syntax error near SELECT'))
	const env = {
		APP_DB: createRemoteConnectorSettingsDb({ all }),
		SECRET_STORE_KEY: 'x'.repeat(32),
	} as Env

	await expect(
		remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-aaa',
			instanceId: 'home',
			sharedSecret: 'home-secret',
		}),
	).rejects.toThrow('syntax error')
	await expect(
		hasRemoteConnectorSharedSecret({
			env,
			userId: 'user-aaa',
			instanceId: 'home',
		}),
	).rejects.toThrow('syntax error')
	expect(all).toHaveBeenCalledTimes(2)
})

test('remote connector shared-secret reads exhaust retryable D1 failures instead of returning empty', async () => {
	const all = vi
		.fn()
		.mockRejectedValue(new Error('D1_ERROR: Network connection lost.'))
	const env = {
		APP_DB: createRemoteConnectorSettingsDb({ all }),
		SECRET_STORE_KEY: 'x'.repeat(32),
	} as Env

	vi.useFakeTimers()
	try {
		const resultPromise = remoteConnectorSharedSecretMatches({
			env,
			userId: 'user-aaa',
			instanceId: 'home',
			sharedSecret: 'home-secret',
		})
		const rejection = expect(resultPromise).rejects.toThrow(
			'Network connection lost',
		)
		for (let attempt = 1; attempt < d1LockRetryMaxAttempts; attempt += 1) {
			await vi.advanceTimersByTimeAsync(
				d1LockRetryBaseDelayMs * 2 ** (attempt - 1),
			)
		}
		await rejection
		expect(all).toHaveBeenCalledTimes(d1LockRetryMaxAttempts)
	} finally {
		vi.useRealTimers()
	}
})
