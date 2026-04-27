import * as Sentry from '@sentry/node'

type EnvRecord = Record<string, string | undefined>
export type HomeConnectorErrorCaptureContext = {
	tags?: Record<string, string>
	contexts?: Record<string, Record<string, unknown>>
	extra?: Record<string, unknown>
}

type HomeConnectorErrorWithCaptureContext = {
	homeConnectorCaptureContext?: HomeConnectorErrorCaptureContext
}

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

function mergeContextRecords(
	base: Record<string, Record<string, unknown>> | undefined,
	override: Record<string, Record<string, unknown>> | undefined,
) {
	if (!base && !override) return undefined
	const merged: Record<string, Record<string, unknown>> = {
		...(base ?? {}),
	}
	for (const [key, value] of Object.entries(override ?? {})) {
		merged[key] = {
			...(merged[key] ?? {}),
			...value,
		}
	}
	return merged
}

export function getHomeConnectorErrorCaptureContext(
	error: unknown,
): HomeConnectorErrorCaptureContext {
	if (!error || typeof error !== 'object') {
		return {}
	}

	const captureContext = (error as HomeConnectorErrorWithCaptureContext)
		.homeConnectorCaptureContext
	if (!captureContext) {
		return {}
	}

	return {
		...(captureContext.tags ? { tags: { ...captureContext.tags } } : {}),
		...(captureContext.contexts
			? { contexts: { ...captureContext.contexts } }
			: {}),
		...(captureContext.extra ? { extra: { ...captureContext.extra } } : {}),
	}
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

	const derivedCaptureContext = getHomeConnectorErrorCaptureContext(error)

	Sentry.captureException(normalizeError(error), {
		...derivedCaptureContext,
		...captureContext,
		tags: {
			service: 'home-connector',
			...(derivedCaptureContext.tags ?? {}),
			...(captureContext.tags ?? {}),
		},
		contexts: mergeContextRecords(
			derivedCaptureContext.contexts,
			captureContext.contexts as
				| Record<string, Record<string, unknown>>
				| undefined,
		),
		extra: {
			...(derivedCaptureContext.extra ?? {}),
			...(captureContext.extra ?? {}),
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

export function addHomeConnectorSentryBreadcrumb(input: {
	message: string
	category: string
	level?: 'info' | 'warning' | 'error'
	data?: Record<string, unknown>
}) {
	if (!Sentry.isEnabled()) {
		return
	}

	Sentry.addBreadcrumb({
		type: 'default',
		category: input.category,
		message: input.message,
		level: input.level ?? 'info',
		data: {
			service: 'home-connector',
			...(input.data ?? {}),
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
