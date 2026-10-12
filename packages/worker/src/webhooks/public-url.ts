/** The endpoint path up to (and without) the URL secret segment. */
export function buildWebhookEndpointPathPrefix(input: {
	username: string
	packageKodyId: string
	webhookName: string
}) {
	return `/@${encodeURIComponent(input.username)}/webhooks/${encodeURIComponent(input.packageKodyId)}/${encodeURIComponent(input.webhookName)}/`
}

export function buildWebhookEndpointPath(input: {
	username: string
	packageKodyId: string
	webhookName: string
	urlSecret: string
}) {
	return `${buildWebhookEndpointPathPrefix(input)}${encodeURIComponent(input.urlSecret)}`
}

export function buildWebhookEndpointUrl(input: {
	origin: string
	username: string
	packageKodyId: string
	webhookName: string
	urlSecret: string
}) {
	return new URL(
		buildWebhookEndpointPath({
			username: input.username,
			packageKodyId: input.packageKodyId,
			webhookName: input.webhookName,
			urlSecret: input.urlSecret,
		}),
		input.origin,
	).toString()
}
