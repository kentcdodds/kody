import {
	type PlatformFeedbackCategory,
	type PlatformFeedbackListItem,
	type PlatformFeedbackRecord,
	type PlatformFeedbackRow,
	type PlatformFeedbackStatus,
} from './types.ts'

const platformFeedbackFullColumns = `id, submitter_user_id, category, summary, details,
	status, reviewed_by_user_id, reviewed_at, admin_note, created_at, updated_at`

const platformFeedbackListColumns = `id, submitter_user_id, category, summary,
	status, reviewed_by_user_id, reviewed_at, created_at, updated_at`

function mapPlatformFeedbackRow(
	row: Record<string, unknown>,
): PlatformFeedbackRecord {
	return {
		id: String(row['id']),
		submitterUserId: String(row['submitter_user_id']),
		category: String(row['category']) as PlatformFeedbackCategory,
		summary: String(row['summary']),
		details: String(row['details']),
		status: String(row['status']) as PlatformFeedbackStatus,
		reviewedByUserId:
			row['reviewed_by_user_id'] == null
				? null
				: String(row['reviewed_by_user_id']),
		reviewedAt: row['reviewed_at'] == null ? null : String(row['reviewed_at']),
		adminNote: row['admin_note'] == null ? null : String(row['admin_note']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapPlatformFeedbackListRow(
	row: Record<string, unknown>,
): PlatformFeedbackListItem {
	return {
		id: String(row['id']),
		submitterUserId: String(row['submitter_user_id']),
		category: String(row['category']) as PlatformFeedbackCategory,
		summary: String(row['summary']),
		status: String(row['status']) as PlatformFeedbackStatus,
		reviewedByUserId:
			row['reviewed_by_user_id'] == null
				? null
				: String(row['reviewed_by_user_id']),
		reviewedAt: row['reviewed_at'] == null ? null : String(row['reviewed_at']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

export async function insertPlatformFeedback(
	db: D1Database,
	row: PlatformFeedbackRow,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO platform_feedback (
				id, submitter_user_id, category, summary, details, status,
				reviewed_by_user_id, reviewed_at, admin_note, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.submitter_user_id,
			row.category,
			row.summary,
			row.details,
			row.status,
			row.reviewed_by_user_id,
			row.reviewed_at,
			row.admin_note,
			row.created_at,
			row.updated_at,
		)
		.run()
}

export async function getPlatformFeedbackByIdForAdmin(
	db: D1Database,
	feedbackId: string,
): Promise<PlatformFeedbackRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${platformFeedbackFullColumns}
			FROM platform_feedback
			WHERE id = ?`,
		)
		.bind(feedbackId)
		.first<Record<string, unknown>>()
	return row ? mapPlatformFeedbackRow(row) : null
}

export async function listPlatformFeedbackRowsForAdmin(
	db: D1Database,
	input: {
		page: number
		pageSize: number
		status?: PlatformFeedbackStatus
		category?: PlatformFeedbackCategory
	},
): Promise<{ total: number; items: Array<PlatformFeedbackListItem> }> {
	const filters: Array<string> = []
	const bindings: Array<unknown> = []
	if (input.status !== undefined) {
		filters.push('status = ?')
		bindings.push(input.status)
	}
	if (input.category !== undefined) {
		filters.push('category = ?')
		bindings.push(input.category)
	}
	const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
	const countRow = await db
		.prepare(`SELECT COUNT(*) AS total FROM platform_feedback ${where}`)
		.bind(...bindings)
		.first<{ total: number }>()
	const rows = await db
		.prepare(
			`SELECT ${platformFeedbackListColumns}
			FROM platform_feedback
			${where}
			ORDER BY created_at DESC, id DESC
			LIMIT ? OFFSET ?`,
		)
		.bind(...bindings, input.pageSize, (input.page - 1) * input.pageSize)
		.all<Record<string, unknown>>()
	return {
		total: Number(countRow?.total ?? 0),
		items: (rows.results ?? []).map(mapPlatformFeedbackListRow),
	}
}

export async function updatePlatformFeedbackStatusForAdmin(
	db: D1Database,
	input: {
		feedbackId: string
		expectedStatus: PlatformFeedbackStatus
		status: PlatformFeedbackStatus
		reviewedByUserId: string
		reviewedAt: string
		adminNote: string | null
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE platform_feedback
			SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?, admin_note = ?,
				updated_at = ?
			WHERE id = ? AND status = ?`,
		)
		.bind(
			input.status,
			input.reviewedByUserId,
			input.reviewedAt,
			input.adminNote,
			input.reviewedAt,
			input.feedbackId,
			input.expectedStatus,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}
