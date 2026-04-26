import * as Sentry from '@sentry/node'

type EnvRecord = Record<string, string | undefined>

const defaultTracesSampleRate = 1.0

let hasInitializedHomeConnectorSentry = false

function parseSentryTracesSampleRate(value: string | undefined) {
	const trimmedValue = value?.trim()
	if (!trimmedValue) {
		return defaultTracesSampleRate
	}

	const parsedValue = Number.parseFloat(trimmedValue)
	if (Number.isFinite(parsedValue) && parsedValue >= 0 && parsedValue <= 1) {
		return parsedValue
	}

	return defaultTracesSampleRate
}

function normalizeError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error))
}

export function buildHomeConnectorSentryOptions(env: EnvRecord = process.env) {
	const dsn = env.SENTRY_DSN?.trim()
	if (!dsn) {
		return undefined
	}

	const environment =
		env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || 'development'
	const release = env.APP_COMMIT_SHA?.trim()

	return {
		dsn,
		environment,
		...(release ? { release } : {}),
		// Default 1.0 = full trace sampling (low-traffic / personal use). Override
		// with `SENTRY_TRACES_SAMPLE_RATE` (for example `0.1`) if event volume grows.
		tracesSampleRate: parseSentryTracesSampleRate(
			env.SENTRY_TRACES_SAMPLE_RATE,
		),
		sendDefaultPii: false,
	}
}

export function initializeHomeConnectorSentry(env: EnvRecord = process.env) {
	if (hasInitializedHomeConnectorSentry || Sentry.isEnabled()) {
		return
	}

	const options = buildHomeConnectorSentryOptions(env)
	if (!options) {
		return
	}

	Sentry.init(options)
	Sentry.setTag('service', 'home-connector')

	const homeConnectorId = env.HOME_CONNECTOR_ID?.trim()
	if (homeConnectorId) {
		Sentry.setTag('home_connector_id', homeConnectorId)
	}

	const workerBaseUrl = env.WORKER_BASE_URL?.trim()
	if (workerBaseUrl) {
		Sentry.setContext('home_connector', {
			workerBaseUrl,
		})
	}

	hasInitializedHomeConnectorSentry = true
}

export function captureHomeConnectorException(
	error: unknown,
	captureContext: Parameters<typeof Sentry.captureException>[1] = {},
) {
	if (!Sentry.isEnabled()) {
		return
	}

	Sentry.captureException(normalizeError(error), {
		...captureContext,
		tags: {
			service: 'home-connector',
			...(captureContext.tags ?? {}),
		},
	})
}

export function captureHomeConnectorMessage(
	message: string,
	captureContext: Exclude<
		Parameters<typeof Sentry.captureMessage>[1],
		string
	> = {},
) {
	if (!Sentry.isEnabled()) {
		return
	}

	Sentry.captureMessage(message, {
		...captureContext,
		tags: {
			service: 'home-connector',
			...(captureContext.tags ?? {}),
		},
	})
}

export async function flushHomeConnectorSentry(timeout = 2_000) {
	if (!Sentry.isEnabled()) {
		return true
	}

	return Sentry.flush(timeout)
}

export async function closeHomeConnectorSentry(timeout = 2_000) {
	if (!Sentry.isEnabled()) {
		return true
	}

	return Sentry.close(timeout)
}
