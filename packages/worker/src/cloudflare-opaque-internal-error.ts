import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'

/**
 * Bare Cloudflare platform "internal error" with no support reference and no
 * app context. Observed on `repoOpenSession` when Durable Object / Artifacts
 * infrastructure fails opaquely (KODY-CLOUDFLARE-4H) and on Artifacts REST
 * (`repo.info`) during package source-safety checks (KODY-8F). Distinct from
 * D1/DO storage resets that carry `reference = <id>`, and from bare
 * `internal error` which stays Sentry-visible because it is too short to
 * attribute safely.
 *
 * Also matches Artifacts `INTERNAL_ERROR` (10400) wording from the public docs.
 * Require the exact sentence (optional trailing period / `Error:` prefix).
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

/**
 * True when any entry in the error cause chain is the bare opaque Cloudflare /
 * Artifacts internal-error sentence. Used by source-safety catch paths to
 * throw a retry-oriented message instead of a recovery wrap (KODY-8F).
 */
export function isCloudflareOpaqueInternalError(error: unknown) {
	return errorCauseChainIncludes(error, isCloudflareOpaqueInternalErrorMessage)
}
