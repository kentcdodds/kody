export class WebhookEndpointIdRaceError extends Error {
	readonly existingId: string

	constructor(existingId: string) {
		super('Unable to upsert webhook endpoint.')
		this.name = 'WebhookEndpointIdRaceError'
		this.existingId = existingId
	}
}
