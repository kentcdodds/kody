import type { CloudflareOptions } from '@sentry/cloudflare'

/**
 * Shared Sentry options for the Cloudflare Worker and Durable Objects.
 * `dsn` may be undefined when Sentry is not configured (local dev / opt-out).
 */
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
