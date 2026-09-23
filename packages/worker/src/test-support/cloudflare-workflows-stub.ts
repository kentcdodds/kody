export class NonRetryableError extends Error {
	constructor(message: string, name = 'NonRetryableError') {
		super(message)
		this.name = name
	}
}
