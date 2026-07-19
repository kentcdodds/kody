import {
	type PlatformFeedbackCategory,
	type PlatformFeedbackListItem,
	type PlatformFeedbackRecordWithRevision,
	type PlatformFeedbackRow,
	type PlatformFeedbackStatus,
} from './types.ts'

const platformFeedbackFullColumns = `id, submitter_user_id, submitter_username,
	submitter_email, category, summary, details, status, reviewed_by_user_id,
	reviewed_at, admin_note, revision, created_at, updated_at`

const platformFeedbackListColumns = `id, submitter_user_id, category, summary,
	status, reviewed_by_user_id, reviewed_at, created_at, updated_at`

function mapPlatformFeedbackRow(
	row: Record<string, unknown>,
): PlatformFeedbackRecordWithRevision {
	return {
		id: String(row['id']),
		submitterUserId: String(row['submitter_user_id']),
		submitterUsername:
			row['submitter_username'] == null
				? null
				: String(row['submitter_username']),
		submitterEmail:
			row['submitter_email'] == null ? null : String(row['submitter_email']),
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
		revision: Number(row['revision']),
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
	limits: {
		activeQueueLimit: number
		rollingWindowStart: string
		submissionRateLimit: number
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT INTO platform_feedback (
				id, submitter_user_id, submitter_username, submitter_email,
				category, summary, details, status, reviewed_by_user_id,
				reviewed_at, admin_note, created_at, updated_at
			)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE (
				SELECT COUNT(*)
				FROM platform_feedback
				WHERE submitter_user_id = ?
					AND status IN ('open', 'triaged')
			) < ?
			AND (
				SELECT COUNT(*)
				FROM platform_feedback
				WHERE submitter_user_id = ?
					AND created_at > ?
			) < ?`,
		)
		.bind(
			row.id,
			row.submitter_user_id,
			row.submitter_username,
			row.submitter_email,
			row.category,
			row.summary,
			row.details,
			row.status,
			row.reviewed_by_user_id,
			row.reviewed_at,
			row.admin_note,
			row.created_at,
			row.updated_at,
			row.submitter_user_id,
			limits.activeQueueLimit,
			row.submitter_user_id,
			limits.rollingWindowStart,
			limits.submissionRateLimit,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function getPlatformFeedbackSubmissionLimitCounts(
	db: D1Database,
	input: {
		submitterUserId: string
		rollingWindowStart: string
	},
) {
	const counts = await db
		.prepare(
			`SELECT
				rolling.rolling_count,
				rolling.oldest_created_at,
				(
					SELECT COUNT(*)
					FROM platform_feedback
					WHERE submitter_user_id = ?
						AND status IN ('open', 'triaged')
				) AS active_count
			FROM (
				SELECT
					COUNT(*) AS rolling_count,
					MIN(created_at) AS oldest_created_at
				FROM platform_feedback
				WHERE submitter_user_id = ?
					AND created_at > ?
			) AS rolling`,
		)
		.bind(
			input.submitterUserId,
			input.submitterUserId,
			input.rollingWindowStart,
		)
		.first<{
			rolling_count: number
			oldest_created_at: string | null
			active_count: number
		}>()
	return {
		rollingCount: Number(counts?.rolling_count ?? 0),
		oldestCreatedAt:
			typeof counts?.oldest_created_at === 'string'
				? counts.oldest_created_at
				: null,
		activeCount: Number(counts?.active_count ?? 0),
	}
}

export async function getPlatformFeedbackByIdForAdmin(
	db: D1Database,
	feedbackId: string,
): Promise<PlatformFeedbackRecordWithRevision | null> {
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
	const items = await listPlatformFeedbackPageRowsForAdmin(db, input)
	return {
		total: Number(countRow?.total ?? 0),
		items,
	}
}

export async function listPlatformFeedbackPageRowsForAdmin(
	db: D1Database,
	input: {
		page: number
		pageSize: number
		status?: PlatformFeedbackStatus
		category?: PlatformFeedbackCategory
	},
): Promise<Array<PlatformFeedbackListItem>> {
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
	return (rows.results ?? []).map(mapPlatformFeedbackListRow)
}

export async function updatePlatformFeedbackStatusForAdmin(
	db: D1Database,
	input: {
		feedbackId: string
		expectedStatus: PlatformFeedbackStatus
		expectedRevision: number
		status: PlatformFeedbackStatus
		reviewedByUserId: string
		reviewedAt: string
		adminNote: string | null | undefined
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE platform_feedback
			SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?,
				admin_note = CASE WHEN ? = 1 THEN ? ELSE admin_note END,
				updated_at = ?, revision = revision + 1
			WHERE id = ? AND status = ? AND revision = ?`,
		)
		.bind(
			input.status,
			input.reviewedByUserId,
			input.reviewedAt,
			input.adminNote === undefined ? 0 : 1,
			input.adminNote ?? null,
			input.reviewedAt,
			input.feedbackId,
			input.expectedStatus,
			input.expectedRevision,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}
