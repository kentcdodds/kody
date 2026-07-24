const alwaysAllowedHeaders = new Set([
	'accept',
	'content-type',
	'user-agent',
	'x-request-id',
	'x-correlation-id',
	'x-github-event',
	'x-github-delivery',
	'x-github-hook-id',
	'x-hub-signature',
	'x-hub-signature-256',
	'sentry-hook-resource',
	'sentry-hook-timestamp',
	'sentry-hook-signature',
	'stripe-signature',
])

/**
 * Collect a safe, lowercase-keyed subset of request headers for package
 * export dispatch. Never forwards Authorization/Cookie/secrets.
 */
export function collectSafeWebhookHeaders(
	request: Request,
	extraAllowedHeaders: ReadonlyArray<string> = [],
) {
	const allowed = new Set(alwaysAllowedHeaders)
	for (const header of extraAllowedHeaders) {
		const normalized = header.trim().toLowerCase()
		if (normalized) allowed.add(normalized)
	}

	const headers: Record<string, string> = {}
	for (const [name, value] of request.headers.entries()) {
		const key = name.toLowerCase()
		if (!allowed.has(key)) continue
		headers[key] = value
	}
	return headers
}
