export type JournalEntryRow = {
	id: string
	user_id: string
	title: string
	content: string
	tags: string
	entry_at: string | null
	created_at: string
	updated_at: string
}

type JournalEntryFields = {
	title: string
	content: string
	tags: string
	entry_at: string | null
}

type JournalEntryListFilters = {
	limit: number
	tag?: string | undefined
}

type JournalEntrySearchFilters = {
	query: string
	limit: number
	tag?: string | undefined
}

export async function insertJournalEntry(
	db: D1Database,
	row: Omit<JournalEntryRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
): Promise<void> {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO journal_entries (
				id, user_id, title, content, tags, entry_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.title,
			row.content,
			row.tags,
			row.entry_at,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.run()
}

export async function getJournalEntryById(
	db: D1Database,
	userId: string,
	entryId: string,
): Promise<JournalEntryRow | null> {
	const result = await db
		.prepare(
			`SELECT id, user_id, title, content, tags, entry_at, created_at, updated_at
			FROM journal_entries
			WHERE id = ? AND user_id = ?`,
		)
		.bind(entryId, userId)
		.first<Record<string, unknown>>()
	if (!result) return null
	return mapJournalEntryRow(result)
}

export async function updateJournalEntry(
	db: D1Database,
	userId: string,
	entryId: string,
	fields: JournalEntryFields,
): Promise<boolean> {
	const now = new Date().toISOString()
	const out = await db
		.prepare(
			`UPDATE journal_entries SET
				title = ?, content = ?, tags = ?, entry_at = ?, updated_at = ?
			WHERE id = ? AND user_id = ?`,
		)
		.bind(
			fields.title,
			fields.content,
			fields.tags,
			fields.entry_at,
			now,
			entryId,
			userId,
		)
		.run()
	return (out.meta.changes ?? 0) > 0
}

export async function deleteJournalEntry(
	db: D1Database,
	userId: string,
	entryId: string,
): Promise<boolean> {
	const out = await db
		.prepare(`DELETE FROM journal_entries WHERE id = ? AND user_id = ?`)
		.bind(entryId, userId)
		.run()
	return (out.meta.changes ?? 0) > 0
}

export async function listJournalEntriesByUserId(
	db: D1Database,
	userId: string,
	filters: JournalEntryListFilters,
): Promise<Array<JournalEntryRow>> {
	const normalizedTag = filters.tag?.trim().toLowerCase() ?? ''
	const tagLike = `%\"${escapeLike(normalizedTag)}\"%`
	const baseSql = `SELECT id, user_id, title, content, tags, entry_at, created_at, updated_at
		FROM journal_entries
		WHERE user_id = ?`
	const orderSql = `ORDER BY COALESCE(entry_at, updated_at) DESC, updated_at DESC
		LIMIT ?`
	const { results } = normalizedTag
		? await db
				.prepare(
					`${baseSql}
					AND LOWER(tags) LIKE ? ESCAPE '\\'
					${orderSql}`,
				)
				.bind(userId, tagLike, filters.limit)
				.all<Record<string, unknown>>()
		: await db
				.prepare(`${baseSql} ${orderSql}`)
				.bind(userId, filters.limit)
				.all<Record<string, unknown>>()
	return (results ?? []).map(mapJournalEntryRow)
}

export async function searchJournalEntriesByUserId(
	db: D1Database,
	userId: string,
	filters: JournalEntrySearchFilters,
): Promise<Array<JournalEntryRow>> {
	const query = filters.query.trim().toLowerCase()
	const normalizedTag = filters.tag?.trim().toLowerCase() ?? ''
	const likeQuery = `%${escapeLike(query)}%`
	const tagLike = `%\"${escapeLike(normalizedTag)}\"%`
	const baseSql = `SELECT id, user_id, title, content, tags, entry_at, created_at, updated_at
		FROM journal_entries
		WHERE user_id = ?
			AND (
				LOWER(title) LIKE ? ESCAPE '\\'
				OR LOWER(content) LIKE ? ESCAPE '\\'
				OR LOWER(tags) LIKE ? ESCAPE '\\'
			)`
	const orderSql = `ORDER BY COALESCE(entry_at, updated_at) DESC, updated_at DESC
		LIMIT ?`
	const { results } = normalizedTag
		? await db
				.prepare(
					`${baseSql}
					AND LOWER(tags) LIKE ? ESCAPE '\\'
					${orderSql}`,
				)
				.bind(userId, likeQuery, likeQuery, likeQuery, tagLike, filters.limit)
				.all<Record<string, unknown>>()
		: await db
				.prepare(`${baseSql} ${orderSql}`)
				.bind(userId, likeQuery, likeQuery, likeQuery, filters.limit)
				.all<Record<string, unknown>>()
	return (results ?? []).map(mapJournalEntryRow)
}

function mapJournalEntryRow(row: Record<string, unknown>): JournalEntryRow {
	return {
		id: String(row['id']),
		user_id: String(row['user_id']),
		title: String(row['title']),
		content: String(row['content']),
		tags: String(row['tags']),
		entry_at: row['entry_at'] == null ? null : String(row['entry_at']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
	}
}

function escapeLike(value: string): string {
	return value
		.replaceAll('\\', '\\\\')
		.replaceAll('%', '\\%')
		.replaceAll('_', '\\_')
}
