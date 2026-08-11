import { expect, test } from 'vitest'
import { EntitlementLimitError } from './entitlements/errors.ts'
import { isUserCodeError, UserCodeError } from './user-code-error.ts'
import {
	cloudflareArtifactsOpaqueInternalErrorMessage,
	cloudflareOpaqueInternalErrorMessage,
	durableObjectBlockConcurrencyWhileTimeoutResetMessage,
	durableObjectCodeUpdatedResetMessage,
	durableObjectIsolateCpuResetMessage,
	durableObjectIsolateMemoryResetMessage,
	durableObjectStorageOperationTimeoutResetMessage,
	executorSandboxTimeoutMessage,
	executorSandboxTimeoutMessageExplanation,
	executorSandboxTimeoutMessagePrefix,
	filterSentryEvent,
	isCloudflareOpaqueInternalErrorMessage,
	isDurableObjectIsolateResourceLimitResetMessage,
} from './sentry-options.ts'

test('filterSentryEvent drops expected platform and caller noise and keeps real errors', () => {
	// Isolate resource-limit resets are the only DO resets that isolated
	// artifact rebuild / check phases treat as retryable.
	expect(
		isDurableObjectIsolateResourceLimitResetMessage(
			durableObjectIsolateMemoryResetMessage,
		),
	).toBe(true)
	expect(
		isDurableObjectIsolateResourceLimitResetMessage(
			durableObjectIsolateCpuResetMessage,
		),
	).toBe(true)
	expect(
		isDurableObjectIsolateResourceLimitResetMessage(
			durableObjectCodeUpdatedResetMessage,
		),
	).toBe(false)
	expect(
		isDurableObjectIsolateResourceLimitResetMessage(
			durableObjectBlockConcurrencyWhileTimeoutResetMessage,
		),
	).toBe(false)

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

	// Exact opaque Cloudflare / Artifacts internal-error sentences are platform
	// blips (KODY-CLOUDFLARE-4H). Bare `internal error` above stays visible;
	// wrapped recovery text must also stay visible.
	expect(
		isCloudflareOpaqueInternalErrorMessage(
			cloudflareOpaqueInternalErrorMessage,
		),
	).toBe(true)
	expect(
		isCloudflareOpaqueInternalErrorMessage(
			cloudflareArtifactsOpaqueInternalErrorMessage.replace(/\.$/, ''),
		),
	).toBe(true)
	expect(
		filterSentryEvent({
			exception: {
				values: [{ value: cloudflareOpaqueInternalErrorMessage }],
			},
		}),
	).toBeNull()
	expect(
		filterSentryEvent({
			exception: {
				values: [{ value: `Error: ${cloudflareOpaqueInternalErrorMessage}` }],
			},
		}),
	).toBeNull()
	const wrappedOpaqueInternal = {
		exception: {
			values: [
				{
					value: `repo_open_session could not recover: ${cloudflareOpaqueInternalErrorMessage}`,
				},
			],
		},
	}
	expect(filterSentryEvent(wrappedOpaqueInternal)).toBe(wrappedOpaqueInternal)

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
	// The executor injects the enforced budget after the leading phrase; both
	// budget spellings stay filtered, as does the bare legacy form emitted by
	// older deployments.
	expect(
		filterSentryEvent({
			message: `${executorSandboxTimeoutMessagePrefix} after 90s${executorSandboxTimeoutMessageExplanation}`,
		}),
	).toBeNull()
	expect(
		filterSentryEvent({
			message: `${executorSandboxTimeoutMessagePrefix} after 40ms${executorSandboxTimeoutMessageExplanation}`,
		}),
	).toBeNull()
	expect(
		filterSentryEvent({ message: executorSandboxTimeoutMessagePrefix }),
	).toBeNull()

	expect(
		filterSentryEvent({
			exception: {
				values: [
					{
						value:
							'The connector "home" is not connected. Kody cannot use this connector until it reconnects. Ask the user to start or reconnect the connector and then try again.',
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
							'Remote capability "home:bond_shade_set_position" failed: timeout',
					},
				],
			},
		}),
	).not.toBeNull()

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

	// Plan-limit denials are account policy, not platform defects. Match the
	// typed originalException (including wrappers) and the serialized type
	// name when the instance is gone.
	const entitlementLimitError = new EntitlementLimitError({
		resource: 'storage_bytes',
		plan: 'free',
		limit: 67_108_864,
		current: 449_966_219,
		upgradeHint:
			'Remove or finish existing storage bytes you no longer need, or upgrade your plan at /account/billing.',
	})
	const entitlementEvent = {
		exception: {
			values: [
				{
					type: 'EntitlementLimitError',
					value: entitlementLimitError.message,
				},
			],
		},
	}
	expect(
		filterSentryEvent(entitlementEvent, {
			originalException: entitlementLimitError,
		}),
	).toBeNull()
	expect(
		filterSentryEvent(entitlementEvent, {
			originalException: new Error('handler failed', {
				cause: entitlementLimitError,
			}),
		}),
	).toBeNull()
	expect(filterSentryEvent(entitlementEvent)).toBeNull()
	expect(
		filterSentryEvent(
			{
				exception: {
					values: [{ type: 'Error', value: entitlementLimitError.message }],
				},
			},
			{ originalException: new Error(entitlementLimitError.message) },
		),
	).not.toBeNull()

	// Bare Cloudflare DO platform resets (memory / CPU / deploy-time code
	// update / blockConcurrencyWhile timeout / storage-op timeout / storage
	// object-reset) are transient — one representative form per family, plus
	// an `Error:`-prefixed variant and a missing trailing period. Wrapped
	// recovery failures and unreferenced storage resets must stay visible.
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
						value: durableObjectCodeUpdatedResetMessage.replace(/\.$/, ''),
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
						value: durableObjectStorageOperationTimeoutResetMessage.replace(
							/\.$/,
							'',
						),
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
							'Internal error in Durable Object storage caused object to be reset; reference = 849rqmf61lg3qbmtb3j6moc4',
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

	const unreferencedDoStorageReset = {
		exception: {
			values: [
				{
					value:
						'Internal error in Durable Object storage caused object to be reset',
				},
			],
		},
	}
	expect(filterSentryEvent(unreferencedDoStorageReset)).toBe(
		unreferencedDoStorageReset,
	)

	const unrelatedDoFailure = {
		exception: {
			values: [{ value: 'Durable Object was reset during migration' }],
		},
	}
	expect(filterSentryEvent(unrelatedDoFailure)).toBe(unrelatedDoFailure)
})
