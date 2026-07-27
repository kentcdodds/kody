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

test('remote connector shared-secret reads ignore env vars and retry transient D1 failures', async () => {
	const envWithoutSettings = {
		APP_DB: createEmptyRemoteConnectorSettingsDb(),
		SECRET_STORE_KEY: 'x'.repeat(32),
		REMOTE_CONNECTOR_SECRETS: {
			'custom:alpha': 'alpha-secret',
			'lights:lights': 'lights-secret',
		},
	} as Env

	await expect(
		resolveRemoteConnectorSharedSecret({
			env: envWithoutSettings,
			userId: 'user-aaa',
			instanceId: 'alpha',
		}),
	).resolves.toBeUndefined()
	await expect(
		remoteConnectorSharedSecretMatches({
			env: envWithoutSettings,
			userId: 'user-aaa',
			instanceId: 'alpha',
			sharedSecret: 'alpha-secret',
		}),
	).resolves.toBe(false)
	await expect(
		hasRemoteConnectorSharedSecret({
			env: envWithoutSettings,
			userId: 'user-aaa',
			instanceId: 'home',
		}),
	).resolves.toBe(false)

	const retryThenSucceed = vi
		.fn()
		.mockRejectedValueOnce(
			new Error('D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY'),
		)
		.mockResolvedValueOnce({ results: [] })
	const retryEnv = {
		APP_DB: createRemoteConnectorSettingsDb({ all: retryThenSucceed }),
		SECRET_STORE_KEY: 'x'.repeat(32),
	} as Env
	vi.useFakeTimers()
	try {
		const resultPromise = remoteConnectorSharedSecretMatches({
			env: retryEnv,
			userId: 'user-aaa',
			instanceId: 'home',
			sharedSecret: 'home-secret',
		})
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(resultPromise).resolves.toBe(false)
		expect(retryThenSucceed).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}

	const nonRetryable = vi
		.fn()
		.mockRejectedValue(new Error('D1_ERROR: syntax error near SELECT'))
	const nonRetryableEnv = {
		APP_DB: createRemoteConnectorSettingsDb({ all: nonRetryable }),
		SECRET_STORE_KEY: 'x'.repeat(32),
	} as Env
	await expect(
		remoteConnectorSharedSecretMatches({
			env: nonRetryableEnv,
			userId: 'user-aaa',
			instanceId: 'home',
			sharedSecret: 'home-secret',
		}),
	).rejects.toThrow('syntax error')
	await expect(
		hasRemoteConnectorSharedSecret({
			env: nonRetryableEnv,
			userId: 'user-aaa',
			instanceId: 'home',
		}),
	).rejects.toThrow('syntax error')
	expect(nonRetryable).toHaveBeenCalledTimes(2)

	const exhausted = vi
		.fn()
		.mockRejectedValue(new Error('D1_ERROR: Network connection lost.'))
	const exhaustedEnv = {
		APP_DB: createRemoteConnectorSettingsDb({ all: exhausted }),
		SECRET_STORE_KEY: 'x'.repeat(32),
	} as Env
	vi.useFakeTimers()
	try {
		const resultPromise = remoteConnectorSharedSecretMatches({
			env: exhaustedEnv,
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
		expect(exhausted).toHaveBeenCalledTimes(d1LockRetryMaxAttempts)
	} finally {
		vi.useRealTimers()
	}
})
