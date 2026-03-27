export function normalizeAllowedCapabilities(input: Array<string>) {
	return Array.from(
		new Set(
			input.map((value) => value.trim()).filter((value) => value.length > 0),
		),
	).sort((left, right) => left.localeCompare(right))
}

export function parseAllowedCapabilities(value: string | null | undefined) {
	if (!value) return []
	try {
		const parsed = JSON.parse(value)
		if (!Array.isArray(parsed)) return []
		return normalizeAllowedCapabilities(
			parsed.filter((entry): entry is string => typeof entry === 'string'),
		)
	} catch {
		return []
	}
}

export function stringifyAllowedCapabilities(input: Array<string>) {
	return JSON.stringify(normalizeAllowedCapabilities(input))
}
