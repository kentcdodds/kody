export const webhookUrlHandlePrefix = 'whh_'

export function formatWebhookUrlHandle(endpointId: string) {
	return `${webhookUrlHandlePrefix}${endpointId}`
}

export function parseWebhookUrlHandle(handle: string) {
	const trimmed = handle.trim()
	if (!trimmed.startsWith(webhookUrlHandlePrefix)) return null
	const endpointId = trimmed.slice(webhookUrlHandlePrefix.length)
	return endpointId.length > 0 ? endpointId : null
}

export function webhookUrlHostFromOrigin(origin: string) {
	try {
		return new URL(origin).host
	} catch {
		return origin.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
	}
}
