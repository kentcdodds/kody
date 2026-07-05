import { isExecutedDirectly } from '../node-runtime.ts'

type Logger = {
	log: (message?: unknown, ...optionalParams: Array<unknown>) => void
	warn: (message?: unknown, ...optionalParams: Array<unknown>) => void
}

type ReindexEnvironment = {
	CAPABILITY_REINDEX_SECRET?: string
	DEPLOY_URL?: string
}

export type PostDeployCapabilityReindexResult =
	| { status: 'skipped'; reason: string }
	| { status: 'ok'; httpStatus: number; body: string }
	| { status: 'failed'; httpStatus?: number; body?: string; error?: string }

export type PostDeployCapabilityReindexOptions = {
	env?: ReindexEnvironment
	fetch?: typeof fetch
	logger?: Logger
	timeoutMs?: number
}

function readOptionalEnvValue(value: string | undefined) {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

function buildReindexUrl(deployUrl: string) {
	return `${deployUrl.replace(/\/+$/, '')}/__maintenance/reindex-capabilities`
}

function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

function formatGithubWarning(message: string) {
	return `::warning::${message
		.replace(/%/g, '%25')
		.replace(/\r/g, '%0D')
		.replace(/\n/g, '%0A')}`
}

function warnAndContinue(logger: Logger, message: string) {
	logger.warn(formatGithubWarning(`${message} Continuing deploy.`))
}

export async function postDeployCapabilityReindex(
	options: PostDeployCapabilityReindexOptions = {},
): Promise<PostDeployCapabilityReindexResult> {
	const env = options.env ?? process.env
	const logger = options.logger ?? console
	const fetchImplementation = options.fetch ?? fetch
	const secret = readOptionalEnvValue(env.CAPABILITY_REINDEX_SECRET)
	const deployUrl = readOptionalEnvValue(env.DEPLOY_URL)

	if (!secret) {
		const reason = 'CAPABILITY_REINDEX_SECRET not set'
		logger.log(`Skipping capability reindex (${reason}).`)
		return { status: 'skipped', reason }
	}

	if (!deployUrl) {
		const reason = 'no deploy URL'
		logger.log(`Skipping capability reindex (${reason}).`)
		return { status: 'skipped', reason }
	}

	const reindexUrl = buildReindexUrl(deployUrl)
	logger.log(`POST ${reindexUrl}`)

	try {
		const response = await fetchImplementation(reindexUrl, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${secret}`,
			},
			signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
		})
		const body = await response.text()
		if (body.trim().length > 0) {
			logger.log(body)
		}

		if (!response.ok) {
			warnAndContinue(
				logger,
				`Capability vector reindex returned HTTP ${response.status}.`,
			)
			return { status: 'failed', httpStatus: response.status, body }
		}

		return { status: 'ok', httpStatus: response.status, body }
	} catch (error) {
		const message = getErrorMessage(error)
		warnAndContinue(logger, `Capability vector reindex failed: ${message}.`)
		return { status: 'failed', error: message }
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await postDeployCapabilityReindex()
}
