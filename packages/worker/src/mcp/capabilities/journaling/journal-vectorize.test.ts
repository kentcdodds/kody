import { expect, test } from 'bun:test'
import {
	buildJournalEntryEmbedText,
	journalEntryVectorId,
	searchJournalEntriesSemantic,
} from './journal-vectorize.ts'

function createEntryRow(input: {
	id: string
	userId?: string
	title: string
	content: string
	tags?: Array<string>
	entryAt?: string | null
}): {
	id: string
	user_id: string
	title: string
	content: string
	tags: string
	entry_at: string | null
	created_at: string
	updated_at: string
} {
	return {
		id: input.id,
		user_id: input.userId ?? 'user-123',
		title: input.title,
		content: input.content,
		tags: JSON.stringify(input.tags ?? []),
		entry_at: input.entryAt ?? '2026-03-21T09:30:00.000Z',
		created_at: '2026-03-21T09:30:00.000Z',
		updated_at: '2026-03-21T09:30:00.000Z',
	}
}

test('journalEntryVectorId uses journal prefix', () => {
	expect(journalEntryVectorId('abc-123')).toBe('journal_abc-123')
})

test('buildJournalEntryEmbedText includes title content and normalized tags', () => {
	const row = createEntryRow({
		id: 'entry-1',
		title: 'Morning reflection',
		content: 'I want to focus on patient debugging and clear thinking.',
		tags: ['focus', 'debugging'],
	})
	const text = buildJournalEntryEmbedText(row)
	expect(text).toContain('Morning reflection')
	expect(text).toContain('patient debugging')
	expect(text).toContain('focus debugging')
	expect(text).toContain('journaling')
})

test('searchJournalEntriesSemantic ranks natural-language recall offline', async () => {
	const rows = [
		createEntryRow({
			id: 'entry-1',
			title: 'Morning reflection',
			content:
				'Today I want to focus on patient debugging, clear thinking, and taking a long walk after lunch.',
			tags: ['focus', 'walk'],
		}),
		createEntryRow({
			id: 'entry-2',
			title: 'Dinner plans',
			content: 'Remember to book a restaurant and pick up flowers.',
			tags: ['personal'],
		}),
	]
	const env = { SENTRY_ENVIRONMENT: 'test' } as Env
	const db = {
		prepare(sql: string) {
			return {
				bind(userId: string, ...params: Array<unknown>) {
					void sql
					void userId
					void params
					return {
						async all() {
							return { results: rows }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const result = await searchJournalEntriesSemantic({
		env,
		db,
		userId: 'user-123',
		filters: {
			query: 'entry about taking a walk and staying thoughtful while debugging',
			limit: 2,
		},
	})

	expect(result.offline).toBe(true)
	expect(result.rows[0]?.id).toBe('entry-1')
	expect(result.rows).toHaveLength(2)
})
