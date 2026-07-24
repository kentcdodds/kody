export function buildWebhookEndpointPath(input: {
	username: string
	endpointId: string
	urlSecret: string
}) {
	return `/@${encodeURIComponent(input.username)}/webhooks/${encodeURIComponent(input.endpointId)}/${encodeURIComponent(input.urlSecret)}`
}

export function buildWebhookEndpointUrl(input: {
	origin: string
	username: string
	endpointId: string
	urlSecret: string
}) {
	return new URL(
		buildWebhookEndpointPath({
			username: input.username,
			endpointId: input.endpointId,
			urlSecret: input.urlSecret,
		}),
		input.origin,
	).toString()
}
