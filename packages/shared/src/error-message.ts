/**
 * Prefer a validated string `message` on Error and Error-shaped objects
 * (for example Cloudflare Artifacts binding throws that do not survive JSRPC
 * as `Error`). Fall back to `String(error)` for everything else.
 */
export function getErrorMessage(error: unknown) {
	if (typeof error === 'string') return error
	if (error instanceof Error) return error.message
	if (
		error !== null &&
		typeof error === 'object' &&
		'message' in error &&
		typeof (error as { message: unknown }).message === 'string'
	) {
		return (error as { message: string }).message
	}
	return String(error)
}

export function getErrorCause(error: unknown) {
	if (error && typeof error === 'object' && 'cause' in error) {
		return (error as { cause?: unknown }).cause
	}
	return undefined
}

export function getErrorCauseChain(error: unknown) {
	const chain: Array<unknown> = []
	const seen = new Set<unknown>()
	let current: unknown = error
	while (current !== undefined && !seen.has(current)) {
		seen.add(current)
		chain.push(current)
		current = getErrorCause(current)
	}
	return chain
}

export function errorCauseChainIncludes(
	error: unknown,
	matches: (message: string) => boolean,
) {
	return getErrorCauseChain(error).some((entry) =>
		matches(getErrorMessage(entry)),
	)
}

export function formatErrorCauseChain(error: unknown) {
	return getErrorCauseChain(error).map(getErrorMessage).join(' Caused by: ')
}
