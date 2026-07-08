/**
 * Parse a `tags_json` DB column into a clean string array. Corrupt JSON or
 * non-array payloads degrade to an empty list instead of throwing, so one bad
 * row cannot take down list/detail reads.
 */
export function parseTagsJson(raw: unknown): Array<string> {
	if (raw == null) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(String(raw))
	} catch {
		return []
	}
	return Array.isArray(parsed)
		? parsed
				.filter((value): value is string => typeof value === 'string')
				.map((value) => value.trim())
				.filter((value) => value.length > 0)
		: []
}
