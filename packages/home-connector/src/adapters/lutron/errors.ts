export class LutronProcessorNotFoundError extends Error {
	constructor(readonly processorId: string) {
		super(`Lutron processor "${processorId}" was not found.`)
		this.name = 'LutronProcessorNotFoundError'
	}
}

export function isLutronProcessorNotFoundError(
	error: unknown,
): error is LutronProcessorNotFoundError {
	return error instanceof LutronProcessorNotFoundError
}
