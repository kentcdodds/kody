export function parseJsonWithFallback<T>(raw: unknown, fallback: T): T {
	if (raw == null || raw === '') return fallback
	try {
		return JSON.parse(String(raw)) as T
	} catch {
		return fallback
	}
}

export function parseJsonArray(raw: unknown): Array<unknown> {
	const parsed = parseJsonWithFallback<unknown>(raw, null)
	return Array.isArray(parsed) ? parsed : []
}

export function parseJsonStringArray(
	raw: unknown,
	options: { trim?: boolean; omitEmpty?: boolean } = {},
): Array<string> {
	const strings = parseJsonArray(raw).filter(
		(value): value is string => typeof value === 'string',
	)
	const normalized = options.trim
		? strings.map((value) => value.trim())
		: strings
	return options.omitEmpty
		? normalized.filter((value) => value.length > 0)
		: normalized
}
