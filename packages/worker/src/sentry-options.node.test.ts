import { type ErrorEvent } from '@sentry/core'
import { expect, test } from 'vitest'
import { isCloudflareKvTransientHttpErrorMessage } from './cloudflare-kv-platform-error.ts'
import {
	ComputeOverageLimitError,
	EntitlementLimitError,
} from './entitlements/errors.ts'
import { isUserCodeError, UserCodeError } from './user-code-error.ts'
import {
	cloudflareArtifactsOpaqueInternalErrorMessage,
	cloudflareOpaqueInternalErrorMessage,
	durableObjectBlockConcurrencyWhileTimeoutResetMessage,
	durableObjectCodeUpdatedResetMessage,
	durableObjectInstanceInactiveCloseMessage,
	durableObjectIsolateMemoryResetMessage,
	durableObjectOverloadedRequestsQueuedTooLongMessage,
	durableObjectOverloadedTooManyRequestsQueuedMessage,
	durableObjectSqliteOutOfMemoryMessage,
	durableObjectStorageOperationTimeoutResetMessage,
	executorSandboxTimeoutMessage,
	executorSandboxTimeoutMessageExplanation,
	executorSandboxTimeoutMessagePrefix,
	filterSentryEvent,
	isCloudflareOpaqueInternalErrorMessage,
	isDurableObjectIsolateResourceLimitResetMessage,
	isMcpAgentSessionDestroyedAbortMessage,
	mcpAgentSessionDestroyedAbortMessage,
} from './sentry-options.ts'

function exceptionEvent(
	...values: Array<string | { type: string; value: string }>
): ErrorEvent {
	return {
		type: undefined,
		exception: {
			values: values.map((value) =>
				typeof value === 'string' ? { value } : value,
			),
		},
	}
}

const noPeriod = (message: string) => message.replace(/\.$/, '')
const artifactsRepo =
	'https://acct.artifacts.cloudflare.net/git/production/repo-1.git'
const cimdFetch404 =
	'CIMD fetch failed for https://chatgpt.com/oauth/client.json: Failed to fetch client metadata: HTTP 404'
const userModuleBuildFailure =
	'Build failed with 1 error:\nvirtual:.__kody_root__/entry.ts:11:49: ERROR: Unexpected "^"'

test('filterSentryEvent drops expected platform and caller noise and keeps real errors', () => {
	// Isolate resource-limit resets are the only DO resets that isolated
	// artifact rebuild / check phases treat as retryable.
	expect(
		isDurableObjectIsolateResourceLimitResetMessage(
			noPeriod(durableObjectSqliteOutOfMemoryMessage),
		),
	).toBe(true)
	expect(
		[
			durableObjectCodeUpdatedResetMessage,
			durableObjectBlockConcurrencyWhileTimeoutResetMessage,
			durableObjectInstanceInactiveCloseMessage,
		].filter(isDurableObjectIsolateResourceLimitResetMessage),
	).toEqual([])

	// Exact opaque Cloudflare / Artifacts internal-error sentences are platform
	// blips (KODY-CLOUDFLARE-4H).
	expect(
		isCloudflareOpaqueInternalErrorMessage(
			noPeriod(cloudflareArtifactsOpaqueInternalErrorMessage),
		),
	).toBe(true)

	// Bare Agents MCP session teardown abort (`ctx.abort("destroyed")`) —
	// KODY-CLOUDFLARE-4K. Wrapped "stream was destroyed" forms stay visible.
	expect(isMcpAgentSessionDestroyedAbortMessage('Error: destroyed')).toBe(true)
	expect(isMcpAgentSessionDestroyedAbortMessage('destroyed.')).toBe(true)
	expect(
		isMcpAgentSessionDestroyedAbortMessage(
			'Cannot call write after a stream was destroyed',
		),
	).toBe(false)

	// Bare Workers KV binding HTTP 5xx / 429 (KODY-7W).
	const kvTransient: Array<[string, boolean]> = [
		['Error: KV PUT failed: 500 Internal Server Error', true],
		['KV GET failed: 429 Too Many Requests', true],
		['KV PUT failed: 400 Bad Request', false],
		[
			'refresh family persist failed: KV PUT failed: 500 Internal Server Error',
			false,
		],
	]
	expect(
		kvTransient.filter(
			([message, expected]) =>
				isCloudflareKvTransientHttpErrorMessage(message) !== expected,
		),
	).toEqual([])

	// Single-exception events that must be dropped. One representative form per
	// family, plus `Error:` / `D1_ERROR:` prefixes and missing trailing periods.
	const dropped = [
		'D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY',
		// D1 blips (with and without D1_ERROR: prefix).
		'Network connection lost.',
		'D1_ERROR: D1 DB is overloaded. Requests queued for too long.',
		'D1_ERROR: D1 DB is overloaded. Too many requests queued.',
		'D1_ERROR: internal error; reference = 0u3odos5iotccpol68ppc0eg',
		'Error: D1_ERROR: internal error; reference = e_Gz3hrU_5c47162d21d24e238a5c25e98b89ee39',
		'D1_ERROR: internal error; reference = e-Gz3hrU-5c47162d21d24e238a5c25e98b89ee39',
		'Internal error in D1 DB storage caused object to be reset; reference = 8t4dqqpoq1ctvjr8kca8fl4c',
		// Opaque Cloudflare internal error.
		cloudflareOpaqueInternalErrorMessage,
		`Error: ${cloudflareOpaqueInternalErrorMessage}`,
		// Artifacts git protocol HTTP 5xx wrappers (KODY-CLOUDFLARE-4Y / 4Z / 50),
		// packfile corruption (KODY-CLOUDFLARE-55 / 56), remote timeouts.
		`Artifacts listServerRefs failed for ${artifactsRepo}: HTTP Error: 500 Internal Server Error`,
		`Artifacts git clone failed for ${artifactsRepo}: Packfile payload corrupted: calculated abc but expected def.`,
		`packageGetGitRemote timed out reading the Artifacts git remote. Retry the call. Artifacts listServerRefs failed for ${artifactsRepo}: Artifacts git request timed out after 8000ms.`,
		// MCP agent session teardown.
		mcpAgentSessionDestroyedAbortMessage,
		'Error: destroyed',
		// User module build failures and sandbox timeouts.
		userModuleBuildFailure,
		executorSandboxTimeoutMessage,
		// OAuth token-refresh caller state (KODY-CLOUDFLARE-4J).
		'Token refresh was rejected for integration "google" with HTTP 400. (integrationTokenRefresh caller state)',
		// DO platform resets (memory / SQLITE_NOMEM / code update / storage-op
		// timeout / storage object-reset / instance-inactive RPC close).
		durableObjectIsolateMemoryResetMessage,
		`Error: ${noPeriod(durableObjectSqliteOutOfMemoryMessage)}`,
		noPeriod(durableObjectCodeUpdatedResetMessage),
		noPeriod(durableObjectStorageOperationTimeoutResetMessage),
		'Internal error in Durable Object storage caused object to be reset; reference = 849rqmf61lg3qbmtb3j6moc4',
		'Error: Internal error in Durable Object storage caused object to be reset; reference = e_Gz3hrU_5c47162d21d24e238a5c25e98b89ee39',
		// KODY-82: D1 bindings surface DO-storage resets under D1_ERROR:.
		'D1_ERROR: Internal error in Durable Object storage caused object to be reset; reference = b44vvje0qcq0ubd9ea522366',
		'Error: D1_ERROR: Internal error in Durable Object storage caused object to be reset; reference = b44vvje0qcq0ubd9ea522366',
		'Internal error in Durable Object storage caused object to be reset; reference = 849rqmf6-1lg3qbmtb3j6moc4',
		noPeriod(durableObjectInstanceInactiveCloseMessage),
		// DO queue saturation (KODY-6J).
		durableObjectOverloadedRequestsQueuedTooLongMessage,
		`Error: ${noPeriod(durableObjectOverloadedTooManyRequestsQueuedMessage)}`,
		// Expected CIMD unknown-client outcomes (KODY-6K / KODY-6M).
		'CIMD metadata resolution failed (metadata_resolution_failed): Client not found',
		cimdFetch404,
		// Workers KV binding 5xx.
		'KV PUT failed: 500 Internal Server Error',
		'Error: KV LIST failed: 503 Service Unavailable',
	]
	expect(
		dropped.filter(
			(value) => filterSentryEvent(exceptionEvent(value)) !== null,
		),
	).toEqual([])

	// Single-exception events that must stay visible: near-misses, bare
	// fragments without the platform marker, and wrapped recovery failures.
	const kept = [
		'Network connection lost while uploading...',
		'queue is overloaded while uploading...',
		'internal error',
		`repoOpenSession could not recover: ${cloudflareOpaqueInternalErrorMessage}`,
		'HTTP Error: 500 Internal Server Error',
		'An internal error caused this command to fail.\n\nUnrelated isomorphic-git InternalError.',
		'Cannot call write after a stream was destroyed',
		'D1_ERROR: Internal error in D1 DB storage caused object to be reset',
		'Token refresh failed for integration "google" with HTTP 503 (server_error).',
		'Integration "spotify" was not found.',
		'Build failed with 1 error:\npackages/worker/src/index.ts:1:0: ERROR: Unexpected "{"',
		'D1_ERROR: syntax error near INSERTZ',
		'Webhook sync invocation timed out.',
		`Error: ${executorSandboxTimeoutMessage}`,
		`packagePublishExternalPush could not recover after 3 transient Durable Object reset attempts: ${durableObjectIsolateMemoryResetMessage}`,
		`UserMeter acquireWriteLease failed after retries: ${durableObjectSqliteOutOfMemoryMessage}`,
		`rebuildPublishedPackageArtifactsViaRepoSession could not recover after 3 transient platform error attempts: Package source publish succeeded, but bundle artifact rebuild failed for source "source-1" at commit "commit-1". Succeeded: none. Failed: ${durableObjectCodeUpdatedResetMessage} Re-run the publish capability to repair artifacts.`,
		'Internal error in Durable Object storage caused object to be reset',
		'D1_ERROR: Internal error in Durable Object storage caused object to be reset',
		'Durable Object was reset during migration',
		`serveMcp could not recover after retries: ${durableObjectOverloadedRequestsQueuedTooLongMessage}`,
		`authorize could not recover after ${cimdFetch404}`,
		'KV PUT failed: 400 Bad Request',
		'refresh family persist failed: KV PUT failed: 500 Internal Server Error',
		'Internal Server Error',
	]
	expect(
		kept.filter((value) => {
			const event = exceptionEvent(value)
			return filterSentryEvent(event) !== event
		}),
	).toEqual([])

	// `message`-only events.
	const droppedMessages = [
		userModuleBuildFailure,
		executorSandboxTimeoutMessage,
		// The executor injects the enforced budget after the leading phrase; both
		// budget spellings stay filtered, as does the bare legacy form.
		`${executorSandboxTimeoutMessagePrefix} after 90s${executorSandboxTimeoutMessageExplanation}`,
		`${executorSandboxTimeoutMessagePrefix} after 40ms${executorSandboxTimeoutMessageExplanation}`,
		executorSandboxTimeoutMessagePrefix,
		'KV DELETE failed: 502 Bad Gateway',
	]
	expect(
		droppedMessages.filter(
			(message) => filterSentryEvent({ type: undefined, message }) !== null,
		),
	).toEqual([])

	// Multi-exception chains: all-noise chains drop; a real outer error keeps
	// the event visible even when the cause is platform noise.
	expect(
		filterSentryEvent(
			exceptionEvent(
				'Currently processing a long-running export.',
				'D1_ERROR: Currently processing a long-running export.',
			),
		),
	).toBeNull()
	for (const event of [
		exceptionEvent(
			'authorize could not recover after a CIMD metadata lookup.',
			cimdFetch404,
		),
		exceptionEvent(
			'completeMcpOAuthTokenRequest could not persist tokens.',
			'KV PUT failed: 500 Internal Server Error',
		),
	]) {
		expect(filterSentryEvent(event)).toBe(event)
	}

	// User-code errors drop via the typed originalException (including causes).
	const userCodeEvent = exceptionEvent({ type: 'UserCodeError', value: 'boom' })
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

	const platformEvent = exceptionEvent({
		type: 'Error',
		value: 'Durable Object storage failed',
	})
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
	const entitlementEvent = exceptionEvent({
		type: 'EntitlementLimitError',
		value: entitlementLimitError.message,
	})
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
	const computeOverageError = new ComputeOverageLimitError({
		resource: 'unique_worker_days',
		plan: 'free',
		limit: 50,
		current: 60,
		creditsStatus: 'add_credits',
	})
	const computeOverageEvent = exceptionEvent({
		type: 'ComputeOverageLimitError',
		value: computeOverageError.message,
	})
	expect(
		filterSentryEvent(computeOverageEvent, {
			originalException: computeOverageError,
		}),
	).toBeNull()
	expect(filterSentryEvent(computeOverageEvent)).toBeNull()
	expect(
		filterSentryEvent(
			exceptionEvent({ type: 'Error', value: entitlementLimitError.message }),
			{ originalException: new Error(entitlementLimitError.message) },
		),
	).not.toBeNull()
})
