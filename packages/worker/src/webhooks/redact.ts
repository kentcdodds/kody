export const webhookUrlPlaceholder = '{{webhookUrl}}'

export function substituteWebhookUrlPlaceholder(
	template: string,
	webhookUrl: string,
) {
	return template.replaceAll(webhookUrlPlaceholder, webhookUrl)
}

export function templateIncludesWebhookUrlPlaceholder(template: string) {
	return template.includes(webhookUrlPlaceholder)
}

function redactPlaintext(value: string, secrets: ReadonlyArray<string>) {
	let redacted = value
	for (const secret of secrets) {
		if (!secret) continue
		redacted = redacted.split(secret).join('[redacted]')
	}
	return redacted
}

export function redactWebhookCredentials(
	value: unknown,
	secrets: ReadonlyArray<string>,
): unknown {
	if (typeof value === 'string') return redactPlaintext(value, secrets)
	if (Array.isArray(value)) {
		return value.map((entry) => redactWebhookCredentials(entry, secrets))
	}
	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {}
		for (const [key, entry] of Object.entries(value)) {
			result[key] = redactWebhookCredentials(entry, secrets)
		}
		return result
	}
	return value
}

export function collectWebhookCredentialSecrets(input: {
	url: string
	urlSecret: string
}) {
	return [input.url, input.urlSecret]
}
