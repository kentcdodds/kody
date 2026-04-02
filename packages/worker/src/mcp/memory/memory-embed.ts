import { type McpMemoryRow } from './types.ts'

function parseJsonStringArray(raw: string): Array<string> {
	try {
		const value = JSON.parse(raw) as unknown
		if (!Array.isArray(value)) return []
		return value.filter((item): item is string => typeof item === 'string')
	} catch {
		return []
	}
}

export function buildMemoryEmbedText(input: {
	category: string | null
	subject: string
	summary: string
	details: string
	tags: Array<string>
	dedupeKey?: string | null
}) {
	return [
		input.category ?? '',
		input.subject,
		input.summary,
		input.details,
		input.tags.join(' '),
		input.dedupeKey ?? '',
	]
		.join('\n')
		.trim()
		.slice(0, 8_000)
}

export function buildMemoryEmbedTextFromRow(row: McpMemoryRow) {
	return buildMemoryEmbedText({
		category: row.category,
		subject: row.subject,
		summary: row.summary,
		details: row.details,
		tags: parseJsonStringArray(row.tags_json),
		dedupeKey: row.dedupe_key,
	})
}

