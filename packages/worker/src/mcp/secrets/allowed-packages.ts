export function normalizeAllowedPackages(input: Array<string>) {
	return Array.from(
		new Set(
			input.map((value) => value.trim()).filter((value) => value.length > 0),
		),
	).sort((left, right) => left.localeCompare(right))
}

export function parseAllowedPackages(value: string | null | undefined) {
	if (!value) return []
	try {
		const parsed = JSON.parse(value)
		if (!Array.isArray(parsed)) return []
		return normalizeAllowedPackages(
			parsed.filter((entry): entry is string => typeof entry === 'string'),
		)
	} catch {
		return []
	}
}

export function stringifyAllowedPackages(input: Array<string>) {
	return JSON.stringify(normalizeAllowedPackages(input))
}
