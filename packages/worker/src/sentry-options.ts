import { type CloudflareOptions } from '@sentry/cloudflare'
import { type ErrorEvent } from '@sentry/core'
import { isRetryableD1LockSentryEvent } from './d1-retry.ts'

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
 * Runtime bundling of caller-supplied modules (MCP execute, inline workflows)
 * puts source under `.__kody_root__/`. When that source is invalid, esbuild
 * throws `Build failed with … virtual:.__kody_root__/…`. Those are user-module
 * mistakes, not platform defects — MCP execute already routes them as sandbox
 * errors, but workflow instrumentation still auto-captures the rethrow.
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
 * that string as `new Error(...)`; `instrumentWorkflowWithSentry` then
 * auto-captures it. MCP execute already skips sandbox failures via
 * `sandboxError`, but workflow instrumentation still reports the rethrow.
 * Other platform timeouts use different wording (Kit, webhook, snapshot, …).
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

export function filterSentryEvent(event: ErrorEvent) {
	if (filterRetryableD1LockSentryEvent(event) === null) return null
	if (filterUserModuleBundlerFailureSentryEvent(event) === null) return null
	if (filterExecutorSandboxTimeoutSentryEvent(event) === null) return null
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
		// opaque "internal error; reference = …" platform faults. These are
		// transient platform unavailability errors retried in app code and
		// should not open or regress Sentry issues.
		//
		// User-module esbuild failures and executor sandbox timeouts from
		// inline workflows are similarly expected caller mistakes; see
		// filterUserModuleBundlerFailureSentryEvent and
		// filterExecutorSandboxTimeoutSentryEvent.
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
