import { z } from 'zod'
import { type JournalEntryRow } from './journal-entries-repo.ts'

export const isoDateTimeSchema = z
	.string()
	.describe(
		'ISO 8601 timestamp. Example: 2026-03-21T09:30:00.000Z. Omit to use the current time or leave null when no journal time is known.',
	)

export const tagFilterSchema = z.string().min(1).max(50).optional()

export const journalEntryInputSchema = z.object({
	title: z
		.string()
		.min(1)
		.max(200)
		.describe('Short title for the journal entry.'),
	content: z
		.string()
		.min(1)
		.max(50_000)
		.describe('Full journal entry body in plain text or markdown.'),
	tags: z
		.array(z.string().min(1).max(50))
		.default([])
		.describe(
			'Optional tags for recall and filtering. Values are normalized to trimmed lowercase strings with duplicates removed.',
		),
	entry_at: isoDateTimeSchema
		.nullable()
		.optional()
		.describe(
			'Optional timestamp representing when the journaled event or reflection happened. Null clears it.',
		),
})

export const journalEntryPatchSchema = z.object({
	entry_id: z.string().min(1).describe('Existing journal entry id to update.'),
	title: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe('Replacement title for the journal entry.'),
	content: z
		.string()
		.min(1)
		.max(50_000)
		.optional()
		.describe('Replacement body for the journal entry.'),
	tags: z
		.array(z.string().min(1).max(50))
		.optional()
		.describe(
			'Optional replacement tags. Values are normalized to trimmed lowercase strings with duplicates removed.',
		),
	entry_at: isoDateTimeSchema
		.nullable()
		.optional()
		.describe(
			'Optional replacement timestamp representing when the journaled event or reflection happened. Null clears it.',
		),
})

export const journalEntryOutputSchema = z.object({
	entry_id: z.string(),
	title: z.string(),
	content: z.string(),
	tags: z.array(z.string()),
	entry_at: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
})

export const journalEntryListOutputSchema = z.object({
	entries: z.array(journalEntryOutputSchema),
	count: z.number().int().min(0),
})

export function normalizeJournalTags(tags: Array<string>): Array<string> {
	return Array.from(
		new Set(
			tags
				.map((tag) => tag.trim().toLowerCase())
				.filter((tag) => tag.length > 0),
		),
	)
}

export function parseJournalTags(raw: string): Array<string> {
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) return []
		return normalizeJournalTags(
			parsed.filter((value): value is string => typeof value === 'string'),
		)
	} catch {
		return []
	}
}

export function journalEntryRowToOutput(row: JournalEntryRow) {
	return {
		entry_id: row.id,
		title: row.title,
		content: row.content,
		tags: parseJournalTags(row.tags),
		entry_at: row.entry_at,
		created_at: row.created_at,
		updated_at: row.updated_at,
	}
}

export function resolveCreateJournalEntryAt(
	entryAt: string | null | undefined,
	now: string,
) {
	if (entryAt === undefined) return now
	return entryAt
}
