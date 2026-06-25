export function getErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
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
