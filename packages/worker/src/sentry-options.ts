import { type CloudflareOptions } from '@sentry/cloudflare'
import { type ErrorEvent, type EventHint } from '@sentry/core'
import { isRetryableD1LockSentryEvent } from './d1-retry.ts'
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
 * Exact message emitted by the execute sandbox when caller code exceeds
 * `timeoutMs` (`packages/worker/src/mcp/executor.ts`). Inline workflows rethrow
 * that string as `UserCodeError`; `instrumentWorkflowWithSentry` then
 * auto-captures it. MCP execute already skips sandbox failures via
 * `sandboxError`, but workflow instrumentation still reports the rethrow.
 * Other platform timeouts use different wording (Kit, webhook, snapshot, …).
 *
 * Backstop for unmarked timeout rethrows. Prefer `UserCodeError` at the
 * boundary; keep this in sync with `executorSandboxTimeoutMessage` in
 * `mcp/executor.ts`.
 */
export const executorSandboxTimeoutMessage = 'Execution timed out'

export function isExecutorSandboxTimeoutSentryEvent(event: ErrorEvent) {
	return sentryEventMessages(event).some(
		(message) => message === executorSandboxTimeoutMessage,
	)
}

export function filterExecutorSandboxTimeoutSentryEvent(event: ErrorEvent) {
	if (!isExecutorSandboxTimeoutSentryEvent(event)) return event
	return null
}

/**
 * Exact Cloudflare Durable Object isolate-reset messages. When a DO hits its
 * memory or CPU limit, the platform resets the isolate and surfaces this error
 * to the RPC caller (for example `job_run_now` → JobManager). The next call
 * gets a fresh isolate; app-level retry is unsafe for non-idempotent jobs, and
 * moving heavy orchestration off JobManager is an architectural change outside
 * a triage fix. Match only the bare platform strings so wrapped failures such
 * as exhausted `package_publish_external_push` recovery messages stay visible.
 */
export const durableObjectIsolateMemoryResetMessage =
	"Durable Object's isolate exceeded its memory limit and was reset."

export const durableObjectIsolateCpuResetMessage =
	'Durable Object exceeded its CPU time limit and was reset.'

function normalizeDurableObjectIsolateResetMessage(message: string) {
	const withoutErrorPrefix = message.trim().replace(/^Error:\s*/i, '')
	return withoutErrorPrefix.endsWith('.')
		? withoutErrorPrefix
		: `${withoutErrorPrefix}.`
}

export function isDurableObjectIsolateResetMessage(message: string) {
	const normalized = normalizeDurableObjectIsolateResetMessage(message)
	return (
		normalized === durableObjectIsolateMemoryResetMessage ||
		normalized === durableObjectIsolateCpuResetMessage
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

export function filterSentryEvent(event: ErrorEvent, hint?: EventHint) {
	// Marker first: primary mechanism for user-authored failures.
	if (filterUserCodeErrorSentryEvent(event, hint) === null) return null
	if (filterRetryableD1LockSentryEvent(event) === null) return null
	// String-match backstops for paths that cannot yet be marked.
	if (filterUserModuleBundlerFailureSentryEvent(event) === null) return null
	if (filterExecutorSandboxTimeoutSentryEvent(event) === null) return null
	if (filterDurableObjectIsolateResetSentryEvent(event) === null) return null
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
		// (`filterUserCodeErrorSentryEvent`). Bundler / sandbox-timeout string
		// matches remain as backstops for unmarked paths; see
		// filterUserModuleBundlerFailureSentryEvent and
		// filterExecutorSandboxTimeoutSentryEvent. Bare Cloudflare Durable
		// Object isolate memory/CPU reset strings are dropped the same way —
		// see filterDurableObjectIsolateResetSentryEvent.
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
