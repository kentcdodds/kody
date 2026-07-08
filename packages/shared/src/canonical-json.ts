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
		// Codepoint (default) sort, not localeCompare: the output feeds hashes
		// and idempotency keys, so ordering must not vary across runtimes.
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, canonicalizeJsonValue(record[key])]),
		)
	}
	return value
}

export function canonicalJsonStringify(value: unknown) {
	return JSON.stringify(canonicalizeJsonValue(value))
}
