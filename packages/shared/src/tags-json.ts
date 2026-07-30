import { parseJsonStringArray } from './json-parsing.ts'

/**
 * Parse a `tags_json` DB column into a clean string array. Corrupt JSON or
 * non-array payloads degrade to an empty list instead of throwing, so one bad
 * row cannot take down list/detail reads.
 */
export function parseTagsJson(raw: unknown): Array<string> {
	return parseJsonStringArray(raw, { trim: true, omitEmpty: true })
}
