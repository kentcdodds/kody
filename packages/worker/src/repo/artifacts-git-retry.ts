import {
	getErrorCauseChain,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'

/**
 * Cloudflare Artifacts git protocol (`info/refs`, upload-pack) occasionally
 * returns 5xx / 429 after REST createToken + repo info already succeeded
 * (KODY-CLOUDFLARE-4Y / 4Z / 50). Short retries paper over the blip without
 * treating it as an application defect.
 */
export const artifactsGitHttpRetryDelaysMs = [50, 150] as const

export function isTransientArtifactsGitHttpStatus(status: number) {
	return (
		status === 429 ||
		status === 500 ||
		status === 502 ||
		status === 503 ||
		status === 504
	)
}

function readHttpStatusFromErrorData(error: unknown): number | null {
	if (!error || typeof error !== 'object' || !('data' in error)) return null
	const data = (error as { data?: { statusCode?: unknown } }).data
	return data && typeof data.statusCode === 'number' ? data.statusCode : null
}

function readHttpStatusFromMessage(message: string): number | null {
	const match = /HTTP Error: (\d{3})\b/i.exec(message)
	if (!match?.[1]) return null
	return Number(match[1])
}

export function getArtifactsGitHttpStatus(error: unknown): number | null {
	for (const entry of getErrorCauseChain(error)) {
		const fromData = readHttpStatusFromErrorData(entry)
		if (fromData != null) return fromData
		if (entry instanceof Error) {
			const fromMessage = readHttpStatusFromMessage(entry.message)
			if (fromMessage != null) return fromMessage
		}
	}
	return null
}

export function isTransientArtifactsGitHttpError(error: unknown) {
	const status = getArtifactsGitHttpStatus(error)
	return status != null && isTransientArtifactsGitHttpStatus(status)
}

/**
 * Stable wrapper phrases used by Artifacts git call sites and the Sentry
 * beforeSend filter. Keep these exact so triage filters stay narrow, and keep
 * the status set aligned with `isTransientArtifactsGitHttpStatus` so we do not
 * drop un-retried failures (e.g. HTTP 501) from Sentry.
 */
export function isArtifactsGitTransientHttpErrorMessage(message: string) {
	const match =
		/Artifacts (?:listServerRefs|git fetch) failed for .+: HTTP Error: (\d{3})\b/i.exec(
			message.trim(),
		)
	if (!match?.[1]) return false
	return isTransientArtifactsGitHttpStatus(Number(match[1]))
}

function describeArtifactRemote(remote: string) {
	try {
		const url = new URL(remote)
		url.username = ''
		url.password = ''
		url.search = ''
		url.hash = ''
		return url.toString()
	} catch {
		return 'unparseable-remote'
	}
}

export function wrapArtifactsGitHttpError(input: {
	operation: 'listServerRefs' | 'git fetch'
	remote: string
	error: unknown
}) {
	return new Error(
		`Artifacts ${input.operation} failed for ${describeArtifactRemote(input.remote)}: ${getErrorMessage(input.error)}`,
		{ cause: input.error },
	)
}

function waitForArtifactsGitRetry(delayMs: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

export async function runArtifactsGitWithRetry<T>(
	operation: () => Promise<T>,
	delaysMs: ReadonlyArray<number> = artifactsGitHttpRetryDelaysMs,
): Promise<T> {
	let lastError: unknown
	const maxAttempts = delaysMs.length + 1
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			return await operation()
		} catch (error) {
			lastError = error
			const canRetry =
				isTransientArtifactsGitHttpError(error) && attempt < maxAttempts - 1
			if (!canRetry) throw error
			const delayMs = delaysMs[attempt]
			if (delayMs !== undefined && delayMs > 0) {
				await waitForArtifactsGitRetry(delayMs)
			}
		}
	}
	throw lastError ?? new Error('Artifacts git operation failed after retries')
}
