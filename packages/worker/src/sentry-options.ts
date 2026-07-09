import { type CloudflareOptions } from '@sentry/cloudflare'
import { type ErrorEvent } from '@sentry/core'
import { isRetryableD1LockSentryEvent } from './d1-retry.ts'

/**
 * Shared Sentry options for the Cloudflare Worker and Durable Objects.
 * `dsn` may be undefined when Sentry is not configured (local dev / opt-out).
 */
export function filterRetryableD1LockSentryEvent(event: ErrorEvent) {
	if (!isRetryableD1LockSentryEvent(event)) return event
	return null
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
		// forwarded them. These are transient lock-contention errors retried in
		// app code and should not open or regress Sentry issues.
		beforeSend: filterRetryableD1LockSentryEvent,
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
