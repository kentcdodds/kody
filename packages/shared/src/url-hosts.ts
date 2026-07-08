/** Hostname of a URL string, or null when the value is not a valid URL. */
export function safeParseHost(raw: string) {
	try {
		return new URL(raw).hostname
	} catch {
		return null
	}
}

/** Normalize a free-form OAuth provider name into a stable lookup key. */
export function normalizeProviderKey(value: string) {
	const normalized = value.trim().toLowerCase()
	return normalized.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}
