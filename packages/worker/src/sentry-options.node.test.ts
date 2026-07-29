import { expect, test } from 'vitest'
import { isUserCodeError, UserCodeError } from './user-code-error.ts'
import {
	durableObjectCodeUpdatedResetMessage,
	durableObjectIsolateCpuResetMessage,
	durableObjectIsolateMemoryResetMessage,
	executorSandboxTimeoutMessage,
	filterSentryEvent,
} from './sentry-options.ts'

test('filterSentryEvent drops expected platform and caller noise and keeps real errors', () => {
	expect(
		filterSentryEvent({
			exception: {
				values: [
					{
						value: 'D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY',
					},
				],
			},
		}),
	).toBeNull()

	expect(
		filterSentryEvent({
			exception: {
				values: [
					{ value: 'Currently processing a long-running export.' },
					{ value: 'D1_ERROR: Currently processing a long-running export.' },
				],
			},
		}),
	).toBeNull()

	// One representative form per D1 blip family (with and without D1_ERROR: prefix).
	expect(
		filterSentryEvent({
			exception: { values: [{ value: 'Network connection lost.' }] },
		}),
	).toBeNull()
	expect(
		filterSentryEvent({
			exception: {
				values: [
					{
						value:
							'D1_ERROR: internal error; reference = 0u3odos5iotccpol68ppc0eg',
					},
				],
			},
		}),
	).toBeNull()
	expect(
		filterSentryEvent({
			exception: {
				values: [
					{
						value:
							'Internal error in D1 DB storage caused object to be reset; reference = 8t4dqqpoq1ctvjr8kca8fl4c',
					},
				],
			},
		}),
	).toBeNull()

	const unrelatedNetworkLoss = {
		exception: {
			values: [{ value: 'Network connection lost while uploading...' }],
		},
	}
	expect(filterSentryEvent(unrelatedNetworkLoss)).toBe(unrelatedNetworkLoss)

	const bareInternalError = {
		exception: { values: [{ value: 'internal error' }] },
	}
	expect(filterSentryEvent(bareInternalError)).toBe(bareInternalError)

	const bareObjectReset = {
		exception: {
			values: [
				{
					value:
						'D1_ERROR: Internal error in D1 DB storage caused object to be reset',
				},
			],
		},
	}
	expect(filterSentryEvent(bareObjectReset)).toBe(bareObjectReset)

	const userModuleBuildFailure = {
		exception: {
			values: [
				{
					value:
						'Build failed with 1 error:\nvirtual:.__kody_root__/entry.ts:11:49: ERROR: Unexpected "^"',
				},
			],
		},
	}
	expect(filterSentryEvent(userModuleBuildFailure)).toBeNull()
	expect(
		filterSentryEvent({
			message:
				'Build failed with 1 error:\nvirtual:.__kody_root__/entry.ts:11:49: ERROR: Unexpected "^"',
		}),
	).toBeNull()

	const sandboxTimeout = {
		exception: {
			values: [{ value: executorSandboxTimeoutMessage }],
		},
	}
	expect(filterSentryEvent(sandboxTimeout)).toBeNull()
	expect(
		filterSentryEvent({ message: executorSandboxTimeoutMessage }),
	).toBeNull()

	const platformBuildFailure = {
		exception: {
			values: [
				{
					value:
						'Build failed with 1 error:\npackages/worker/src/index.ts:1:0: ERROR: Unexpected "{"',
				},
			],
		},
	}
	expect(filterSentryEvent(platformBuildFailure)).toBe(platformBuildFailure)

	const syntaxError = {
		exception: {
			values: [{ value: 'D1_ERROR: syntax error near INSERTZ' }],
		},
	}
	expect(filterSentryEvent(syntaxError)).toBe(syntaxError)

	const webhookTimeout = {
		exception: {
			values: [{ value: 'Webhook sync invocation timed out.' }],
		},
	}
	expect(filterSentryEvent(webhookTimeout)).toBe(webhookTimeout)

	const prefixedSandboxTimeout = {
		exception: {
			values: [{ value: `Error: ${executorSandboxTimeoutMessage}` }],
		},
	}
	expect(filterSentryEvent(prefixedSandboxTimeout)).toBe(prefixedSandboxTimeout)

	const userCodeEvent = {
		exception: {
			values: [{ type: 'UserCodeError', value: 'boom' }],
		},
	}
	expect(
		filterSentryEvent(userCodeEvent, {
			originalException: new UserCodeError('boom'),
		}),
	).toBeNull()
	expect(
		filterSentryEvent(userCodeEvent, {
			originalException: new Error('wrapper', {
				cause: new UserCodeError('boom'),
			}),
		}),
	).toBeNull()

	const nestedUserCode = new Error('handler failed', {
		cause: new Error('step failed', { cause: new UserCodeError('boom') }),
	})
	expect(isUserCodeError(new UserCodeError('boom'))).toBe(true)
	expect(isUserCodeError(nestedUserCode)).toBe(true)
	expect(isUserCodeError(new Error('platform blew up'))).toBe(false)
	expect(isUserCodeError('boom')).toBe(false)
	expect(isUserCodeError(null)).toBe(false)

	const platformEvent = {
		exception: {
			values: [{ type: 'Error', value: 'Durable Object storage failed' }],
		},
	}
	expect(
		filterSentryEvent(platformEvent, {
			originalException: new Error('Durable Object storage failed'),
		}),
	).toBe(platformEvent)
	expect(filterSentryEvent(platformEvent)).toBe(platformEvent)

	// Bare Cloudflare DO platform resets (memory / CPU / deploy-time code
	// update) are transient — one representative form per family, plus an
	// `Error:`-prefixed variant and a missing trailing period. Wrapped
	// recovery failures must stay visible.
	expect(
		filterSentryEvent({
			exception: {
				values: [{ value: durableObjectIsolateMemoryResetMessage }],
			},
		}),
	).toBeNull()
	expect(
		filterSentryEvent({
			exception: {
				values: [
					{
						value: `Error: ${durableObjectIsolateCpuResetMessage}`,
					},
				],
			},
		}),
	).toBeNull()
	expect(
		filterSentryEvent({
			exception: {
				values: [
					{
						value: durableObjectCodeUpdatedResetMessage.replace(/\.$/, ''),
					},
				],
			},
		}),
	).toBeNull()

	const exhaustedPublishRecovery = {
		exception: {
			values: [
				{
					value: `package_publish_external_push could not recover after 3 transient Durable Object reset attempts: ${durableObjectIsolateMemoryResetMessage}`,
				},
			],
		},
	}
	expect(filterSentryEvent(exhaustedPublishRecovery)).toBe(
		exhaustedPublishRecovery,
	)

	const unrelatedDoFailure = {
		exception: {
			values: [{ value: 'Durable Object was reset during migration' }],
		},
	}
	expect(filterSentryEvent(unrelatedDoFailure)).toBe(unrelatedDoFailure)
})
