import { type CloudflareOptions } from '@sentry/cloudflare'
import { type ErrorEvent, type EventHint } from '@sentry/core'
import { getErrorCauseChain } from '@kody-internal/shared/error-message.ts'
import { isEntitlementLimitError } from './entitlements/errors.ts'
import { isRetryableD1LockSentryEvent } from './d1-retry.ts'
import { isIntegrationTokenRefreshCallerMessage } from './integrations/token-refresh.ts'
import { isRemoteConnectorUnavailableMessage } from './remote-connector/status.ts'
import { isUserCodeError } from './user-code-error.ts'

function sentryEventMessages(event: ErrorEvent) {
	return [
		event.message,
		...(event.exception?.values?.map((value) => value.value) ?? []),
	]
}

/**
 * Shared Sentry options for the Cloudflare Worker and Durable Objects.
 * `dsn` may be undefined when Sentry is not configured (local dev / opt-out).
 */
export function filterRetryableD1LockSentryEvent(event: ErrorEvent) {
	if (!isRetryableD1LockSentryEvent(event)) return event
	return null
}

/**
 * Primary drop path for user-authored failures. Boundaries that know the code
 * is user-supplied throw `UserCodeError`; `beforeSend` receives that as
 * `hint.originalException` (including when wrapped further up the cause chain).
 */
export function filterUserCodeErrorSentryEvent(
	_event: ErrorEvent,
	hint?: EventHint,
) {
	if (isUserCodeError(hint?.originalException)) return null
	return _event
}

/**
 * Plan-limit denials are expected account policy outcomes (clean up usage or
 * upgrade), not platform defects. MCP observability already skips them via
 * `isCallerFailure`; this `beforeSend` gate is the backstop for any other
 * capture path that still forwards the typed error.
 */
export function isEntitlementLimitErrorSentryEvent(
	event: ErrorEvent,
	hint?: EventHint,
) {
	if (
		getErrorCauseChain(hint?.originalException).some(isEntitlementLimitError)
	) {
		return true
	}
	return (
		event.exception?.values?.some(
			(value) => value.type === 'EntitlementLimitError',
		) ?? false
	)
}

export function filterEntitlementLimitErrorSentryEvent(
	event: ErrorEvent,
	hint?: EventHint,
) {
	if (!isEntitlementLimitErrorSentryEvent(event, hint)) return event
	return null
}

/**
 * Runtime bundling of caller-supplied modules (MCP execute, inline workflows)
 * puts source under `.__kody_root__/`. When that source is invalid, esbuild
 * throws `Build failed with … virtual:.__kody_root__/…`. Those are user-module
 * mistakes, not platform defects — MCP execute already routes them as sandbox
 * errors, but workflow instrumentation still auto-captures the rethrow.
 *
 * Backstop for paths that cannot throw `UserCodeError` (e.g. bundler failures
 * that escape before a marked wrap). Prefer marking at the boundary.
 */
export function isUserModuleBundlerFailureSentryEvent(event: ErrorEvent) {
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			message.includes('Build failed with') &&
			message.includes('.__kody_root__/'),
	)
}

export function filterUserModuleBundlerFailureSentryEvent(event: ErrorEvent) {
	if (!isUserModuleBundlerFailureSentryEvent(event)) return event
	return null
}

/**
 * Leading phrase of the message emitted by the execute sandbox when caller
 * code exceeds `timeoutMs` (`packages/worker/src/mcp/executor.ts`). The
 * executor injects the enforced budget after this phrase (`Execution timed
 * out after 90s: …` via `createExecutorSandboxTimeoutMessage`) so consumers
 * can tell a 90s ad hoc execute cut from a 270s workflow-step cut.
 */
export const executorSandboxTimeoutMessagePrefix = 'Execution timed out'

/**
 * Abort-semantics explanation carried by every sandbox timeout message:
 * nested work is asked to abort, but already-started side effects may still
 * complete, so retries need idempotency.
 */
export const executorSandboxTimeoutMessageExplanation =
	': Kody stopped observing the sandbox. Nested work was asked to abort, but already-started remote work and side effects may still complete. Do not retry side-effecting work without an idempotencyKey; recover with run_get or replay the same idempotencyKey.'

/**
 * Budget-less form of the sandbox timeout message. Inline workflows rethrow
 * timeout strings as `UserCodeError`; `instrumentWorkflowWithSentry` then
 * auto-captures them. MCP execute already skips sandbox failures via
 * `sandboxError`, but workflow instrumentation still reports the rethrow.
 * Other platform timeouts use different wording (Kit, webhook, snapshot, …).
 *
 * Backstop for unmarked timeout rethrows. Prefer `UserCodeError` at the
 * boundary; keep this in sync with `createExecutorSandboxTimeoutMessage` in
 * `mcp/executor.ts`.
 */
export const executorSandboxTimeoutMessage = `${executorSandboxTimeoutMessagePrefix}${executorSandboxTimeoutMessageExplanation}`

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Anchored on purpose: wrapped forms (for example `Error: Execution timed
 * out`) are rethrows from other layers and must keep reaching Sentry. The
 * budget and the explanation are each optional so timeout messages from
 * older deployments (bare `Execution timed out`) stay filtered too.
 */
const executorSandboxTimeoutMessagePattern = new RegExp(
	`^${executorSandboxTimeoutMessagePrefix}(?: after \\d+(?:\\.\\d+)?m?s)?(?:${escapeRegExp(executorSandboxTimeoutMessageExplanation)})?$`,
)

export function isExecutorSandboxTimeoutMessage(message: string | undefined) {
	return (
		message !== undefined && executorSandboxTimeoutMessagePattern.test(message)
	)
}

export function isExecutorSandboxTimeoutSentryEvent(event: ErrorEvent) {
	return sentryEventMessages(event).some(isExecutorSandboxTimeoutMessage)
}

export function filterExecutorSandboxTimeoutSentryEvent(event: ErrorEvent) {
	if (!isExecutorSandboxTimeoutSentryEvent(event)) return event
	return null
}

/**
 * Offline / empty / session-unavailable remote connectors are caller-clearable
 * user state (reconnect the connector). MCP observability already skips them
 * via `isCallerFailure`; this `beforeSend` gate is the backstop for any other
 * capture path that still forwards the plain Error message.
 */
export function isRemoteConnectorUnavailableSentryEvent(event: ErrorEvent) {
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isRemoteConnectorUnavailableMessage(message),
	)
}

export function filterRemoteConnectorUnavailableSentryEvent(event: ErrorEvent) {
	if (!isRemoteConnectorUnavailableSentryEvent(event)) return event
	return null
}

/**
 * OAuth token-refresh caller state (no refresh token on the connection,
 * provider HTTP 4xx / invalid_grant, missing secrets). MCP observability
 * already skips them via `isCallerFailure`; this `beforeSend` gate is the
 * backstop for any other capture path that still forwards the plain Error.
 */
export function isIntegrationTokenRefreshCallerSentryEvent(event: ErrorEvent) {
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isIntegrationTokenRefreshCallerMessage(message),
	)
}

export function filterIntegrationTokenRefreshCallerSentryEvent(
	event: ErrorEvent,
) {
	if (!isIntegrationTokenRefreshCallerSentryEvent(event)) return event
	return null
}

/**
 * Exact Cloudflare Durable Object platform-reset messages. When a DO hits its
 * memory or CPU limit, when a deploy replaces DO code under an in-flight
 * RPC/alarm (for example cron `oauth_purge_expired` → OAuthPurgeCoordinator),
 * when `blockConcurrencyWhile` exceeds its ~30s deadlock timeout (for
 * example PartyServer awaiting MCP Agent `onStart` via `getServerByName` →
 * `setName`), when a DO SQLite storage operation exceeds the platform timeout
 * and resets the object, or when DO SQLite storage hits an opaque internal
 * fault and resets the object, the platform surfaces one of these errors to
 * the caller. The next call gets a fresh isolate / storage handle; app-level
 * retry of non-idempotent work is still unsafe, and moving heavy Agent/MCP
 * startup out of `onStart` is an architectural change outside a triage fix.
 * Match only the bare platform strings (plus the storage form that requires
 * a support `reference =` token) so wrapped failures such as exhausted
 * `package_publish_external_push` recovery messages stay visible.
 */
export const durableObjectIsolateMemoryResetMessage =
	"Durable Object's isolate exceeded its memory limit and was reset."

export const durableObjectIsolateCpuResetMessage =
	'Durable Object exceeded its CPU time limit and was reset.'

export const durableObjectCodeUpdatedResetMessage =
	'Durable Object reset because its code was updated.'

export const durableObjectBlockConcurrencyWhileTimeoutResetMessage =
	'A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset.'

/**
 * Cloudflare Durable Object SQLite storage operation timeout that resets the
 * object (KODY-CLOUDFLARE-3M). Same platform-reset class as memory/CPU /
 * blockConcurrencyWhile timeouts — not an application defect.
 */
export const durableObjectStorageOperationTimeoutResetMessage =
	'Durable Object storage operation exceeded timeout which caused object to be reset.'

/**
 * Cloudflare Durable Object SQLite storage opaque platform fault with a
 * support reference, e.g.
 * `Internal error in Durable Object storage caused object to be reset; reference = <id>`.
 * Same class as D1's `Internal error in D1 DB storage caused object to be
 * reset` (see `d1-retry.ts`): not an application defect — DO storage hit an
 * internal fault. Require `reference =` and this exact phrasing so bare /
 * unrelated "Durable Object storage …" messages stay Sentry-visible.
 */
const durableObjectStorageObjectResetPattern =
	/^internal error in Durable Object storage caused object to be reset;\s*reference\s*=\s*[A-Za-z0-9]+$/i

function normalizeDurableObjectIsolateResetMessage(message: string) {
	const withoutErrorPrefix = message.trim().replace(/^Error:\s*/i, '')
	return withoutErrorPrefix.endsWith('.')
		? withoutErrorPrefix
		: `${withoutErrorPrefix}.`
}

export function isDurableObjectStorageObjectResetMessage(message: string) {
	const withoutErrorPrefix = message.trim().replace(/^Error:\s*/i, '')
	return durableObjectStorageObjectResetPattern.test(withoutErrorPrefix)
}

/**
 * Memory/CPU isolate resets only. Isolated throwaway runners remap these to
 * actionable "package too large" outcomes; deploy resets ("code was updated")
 * and other platform resets must keep propagating so idempotent callers can
 * retry on a fresh isolate.
 */
export function isDurableObjectIsolateResourceLimitResetMessage(
	message: string,
) {
	const normalized = normalizeDurableObjectIsolateResetMessage(message)
	return (
		normalized === durableObjectIsolateMemoryResetMessage ||
		normalized === durableObjectIsolateCpuResetMessage
	)
}

export function isDurableObjectIsolateResetMessage(message: string) {
	const normalized = normalizeDurableObjectIsolateResetMessage(message)
	return (
		isDurableObjectIsolateResourceLimitResetMessage(message) ||
		normalized === durableObjectCodeUpdatedResetMessage ||
		normalized === durableObjectBlockConcurrencyWhileTimeoutResetMessage ||
		normalized === durableObjectStorageOperationTimeoutResetMessage ||
		isDurableObjectStorageObjectResetMessage(message)
	)
}

export function isDurableObjectIsolateResetSentryEvent(event: ErrorEvent) {
	const messages = sentryEventMessages(event).filter(
		(message): message is string =>
			typeof message === 'string' && message.trim().length > 0,
	)
	// Drop only when every reported message is a bare reset. A chained cause
	// that pairs a recovery/wrapper value with an inner reset must stay visible.
	return (
		messages.length > 0 &&
		messages.every((message) => isDurableObjectIsolateResetMessage(message))
	)
}

export function filterDurableObjectIsolateResetSentryEvent(event: ErrorEvent) {
	if (!isDurableObjectIsolateResetSentryEvent(event)) return event
	return null
}

/**
 * Bare Cloudflare platform "internal error" with no support reference and no
 * app context. Observed on `repo_open_session` when Durable Object / Artifacts
 * infrastructure fails opaquely (KODY-CLOUDFLARE-4H). Distinct from D1/DO
 * storage resets that carry `reference = <id>`, and from bare `internal error`
 * which stays Sentry-visible because it is too short to attribute safely.
 *
 * Also matches Artifacts `INTERNAL_ERROR` (10400) wording from the public docs.
 * Require the exact sentence (optional trailing period / `Error:` prefix) so
 * wrapped recovery messages stay visible.
 */
export const cloudflareOpaqueInternalErrorMessage =
	'An internal error occurred.'

export const cloudflareArtifactsOpaqueInternalErrorMessage =
	'An unexpected internal error occurred.'

function normalizeCloudflareOpaqueInternalErrorMessage(message: string) {
	const withoutErrorPrefix = message.trim().replace(/^Error:\s*/i, '')
	return withoutErrorPrefix.endsWith('.')
		? withoutErrorPrefix
		: `${withoutErrorPrefix}.`
}

export function isCloudflareOpaqueInternalErrorMessage(message: string) {
	const normalized = normalizeCloudflareOpaqueInternalErrorMessage(message)
	return (
		normalized === cloudflareOpaqueInternalErrorMessage ||
		normalized === cloudflareArtifactsOpaqueInternalErrorMessage
	)
}

export function isCloudflareOpaqueInternalErrorSentryEvent(event: ErrorEvent) {
	const messages = sentryEventMessages(event).filter(
		(message): message is string =>
			typeof message === 'string' && message.trim().length > 0,
	)
	return (
		messages.length > 0 &&
		messages.every((message) => isCloudflareOpaqueInternalErrorMessage(message))
	)
}

export function filterCloudflareOpaqueInternalErrorSentryEvent(
	event: ErrorEvent,
) {
	if (!isCloudflareOpaqueInternalErrorSentryEvent(event)) return event
	return null
}

/**
 * Bare Durable Object abort reason from Cloudflare Agents MCP session
 * teardown (`ctx.abort("destroyed")` inside `Agent.destroy()` /
 * `_cf_scheduleDestroy`). Observed on `/mcp` when a Streamable-HTTP client
 * DELETEs its session (or a concurrent request races the abort) —
 * KODY-CLOUDFLARE-4K. Same class as other DO platform-reset strings: not an
 * application defect. Match only the exact abort token (optional `Error:`
 * prefix / trailing period) so wrapped forms such as "stream was destroyed"
 * or "Cannot call write after a stream was destroyed" stay Sentry-visible.
 */
export const mcpAgentSessionDestroyedAbortMessage = 'destroyed'

function normalizeMcpAgentSessionDestroyedAbortMessage(message: string) {
	const withoutErrorPrefix = message.trim().replace(/^Error:\s*/i, '')
	return withoutErrorPrefix.endsWith('.')
		? withoutErrorPrefix.slice(0, -1)
		: withoutErrorPrefix
}

export function isMcpAgentSessionDestroyedAbortMessage(message: string) {
	return (
		normalizeMcpAgentSessionDestroyedAbortMessage(message) ===
		mcpAgentSessionDestroyedAbortMessage
	)
}

export function isMcpAgentSessionDestroyedAbortSentryEvent(event: ErrorEvent) {
	const messages = sentryEventMessages(event).filter(
		(message): message is string =>
			typeof message === 'string' && message.trim().length > 0,
	)
	return (
		messages.length > 0 &&
		messages.every((message) => isMcpAgentSessionDestroyedAbortMessage(message))
	)
}

export function filterMcpAgentSessionDestroyedAbortSentryEvent(
	event: ErrorEvent,
) {
	if (!isMcpAgentSessionDestroyedAbortSentryEvent(event)) return event
	return null
}

export function filterSentryEvent(event: ErrorEvent, hint?: EventHint) {
	// Marker first: primary mechanism for user-authored failures.
	if (filterUserCodeErrorSentryEvent(event, hint) === null) return null
	if (filterEntitlementLimitErrorSentryEvent(event, hint) === null) return null
	if (filterRetryableD1LockSentryEvent(event) === null) return null
	// String-match backstops for paths that cannot yet be marked.
	if (filterUserModuleBundlerFailureSentryEvent(event) === null) return null
	if (filterExecutorSandboxTimeoutSentryEvent(event) === null) return null
	if (filterRemoteConnectorUnavailableSentryEvent(event) === null) return null
	if (filterIntegrationTokenRefreshCallerSentryEvent(event) === null)
		return null
	if (filterDurableObjectIsolateResetSentryEvent(event) === null) return null
	if (filterCloudflareOpaqueInternalErrorSentryEvent(event) === null)
		return null
	if (filterMcpAgentSessionDestroyedAbortSentryEvent(event) === null)
		return null
	return event
}

export function buildSentryOptions(env: Env): CloudflareOptions {
	const dsn = env.SENTRY_DSN?.trim()
	const environment = env.SENTRY_ENVIRONMENT?.trim() || 'development'
	const release = env.APP_COMMIT_SHA?.trim()
	// Default 1.0 = full trace sampling (low-traffic / personal use). Override with
	// `SENTRY_TRACES_SAMPLE_RATE` (e.g. 0.1) if volume or Sentry quota grows.
	const tracesSampleRate =
		typeof env.SENTRY_TRACES_SAMPLE_RATE === 'number'
			? env.SENTRY_TRACES_SAMPLE_RATE
			: 1.0

	return {
		...(dsn ? { dsn } : {}),
		environment,
		...(release ? { release } : {}),
		tracesSampleRate,
		sendDefaultPii: false,
		// D1 marks SQLITE_BUSY with NOSENTRY at the storage layer, but
		// application capture paths (for example scheduled_lane_failed) still
		// forwarded them. The same applies to "Currently processing a
		// long-running export" while the nightly DR D1 export holds the DB,
		// "Network connection lost" when the D1 binding drops mid-query, and
		// opaque D1 "internal error …; reference = …" platform faults
		// (including storage object-reset). These are transient platform
		// unavailability errors retried in app code and should not open or
		// regress Sentry issues.
		//
		// User-authored failures are dropped primarily via `UserCodeError`
		// (`filterUserCodeErrorSentryEvent`). Plan-limit denials
		// (`EntitlementLimitError`) are dropped the same way — expected
		// account policy, still visible on structured `mcp-event` logs. Bundler
		// / sandbox-timeout string matches remain as backstops for unmarked
		// paths; see filterUserModuleBundlerFailureSentryEvent and
		// filterExecutorSandboxTimeoutSentryEvent. Offline remote-connector
		// guidance messages are dropped the same way — see
		// filterRemoteConnectorUnavailableSentryEvent. OAuth token-refresh
		// caller state (missing refresh token, provider 4xx / invalid_grant)
		// is dropped the same way — see
		// filterIntegrationTokenRefreshCallerSentryEvent. Bare Cloudflare Durable
		// Object platform reset strings (memory/CPU limits, deploy-time code
		// updates, blockConcurrencyWhile timeouts, DO storage operation
		// timeouts, and DO storage object-reset with a support reference) are
		// dropped the same way — see filterDurableObjectIsolateResetSentryEvent.
		// Exact opaque Cloudflare "An internal error occurred." (and Artifacts
		// INTERNAL_ERROR wording) with no support reference are dropped the
		// same way — see filterCloudflareOpaqueInternalErrorSentryEvent.
		// Bare Durable Object abort token `destroyed` from Agents MCP session
		// teardown (`ctx.abort("destroyed")`) is dropped the same way — see
		// filterMcpAgentSessionDestroyedAbortSentryEvent.
		beforeSend: filterSentryEvent,
	}
}

/**
 * Top-level Worker: skip Sentry wrapper overhead when no DSN is configured.
 */
export function getWorkerSentryOptions(
	env: Env,
): CloudflareOptions | undefined {
	const options = buildSentryOptions(env)
	return options.dsn ? options : undefined
}
