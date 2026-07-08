/**
 * Recursively sort object keys so that JSON.stringify output is stable for
 * hashing and idempotency keys regardless of property insertion order.
 */
export function canonicalizeJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => canonicalizeJsonValue(entry))
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>
		return Object.fromEntries(
			Object.keys(record)
				.sort((left, right) => left.localeCompare(right))
				.map((key) => [key, canonicalizeJsonValue(record[key])]),
		)
	}
	return value
}

export function canonicalJsonStringify(value: unknown) {
	return JSON.stringify(canonicalizeJsonValue(value))
}
