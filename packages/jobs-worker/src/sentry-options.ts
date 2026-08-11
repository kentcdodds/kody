import { type CloudflareOptions } from '@sentry/cloudflare'
import { type JobsWorkerEnv } from './env.ts'

export function buildSentryOptions(env: JobsWorkerEnv): CloudflareOptions {
	const dsn = env.SENTRY_DSN?.trim()
	const environment = env.SENTRY_ENVIRONMENT?.trim() || 'development'
	const release = env.APP_COMMIT_SHA?.trim()
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
