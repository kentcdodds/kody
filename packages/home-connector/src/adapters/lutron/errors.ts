export class LutronProcessorNotFoundError extends Error {
	readonly processorId: string

	constructor(processorId: string) {
		super(`Lutron processor "${processorId}" was not found.`)
		this.name = 'LutronProcessorNotFoundError'
		this.processorId = processorId
	}
}

export function isLutronProcessorNotFoundError(
	error: unknown,
): error is LutronProcessorNotFoundError {
	return error instanceof LutronProcessorNotFoundError
}
