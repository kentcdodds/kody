/**
 * Parse a stored JSON string-array column (`tags_json`, `source_uris_json`).
 * Corrupt JSON or non-array payloads degrade to an empty list instead of
 * throwing, so one bad row cannot fail a whole memory search/list response.
 */
export function parseJsonStringArray(raw: string): Array<string> {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		return []
	}
	if (!Array.isArray(value)) return []
	return value.filter((item): item is string => typeof item === 'string')
}
