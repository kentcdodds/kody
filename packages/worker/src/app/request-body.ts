export function readNonEmptyTrimmedString(
	body: object,
	key: string,
): string | null {
	const value = (body as Record<string, unknown>)[key]
	if (typeof value !== 'string') {
		return null
	}

	const trimmed = value.trim()
	return trimmed ? trimmed : null
}

export function readNonEmptyTrimmedStringOrNumber(
	body: object,
	key: string,
): string | null {
	const value = (body as Record<string, unknown>)[key]
	if (typeof value === 'string') {
		const trimmed = value.trim()
		return trimmed ? trimmed : null
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return String(value)
	}
	return null
}

export function readTrimmedStringOrEmpty(body: object, key: string): string {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' ? value.trim() : ''
}
