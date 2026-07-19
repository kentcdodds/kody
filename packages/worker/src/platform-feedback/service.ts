import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import {
	PlatformFeedbackActiveQueueLimitError,
	PlatformFeedbackConcurrentUpdateError,
	PlatformFeedbackInvalidTransitionError,
	PlatformFeedbackNotFoundError,
	PlatformFeedbackSubmissionRateLimitError,
} from './errors.ts'
import {
	getPlatformFeedbackByIdForAdmin,
	insertPlatformFeedback,
	listPlatformFeedbackRowsForAdmin,
	updatePlatformFeedbackStatusForAdmin,
} from './repo.ts'
import {
	type PlatformFeedbackAction,
	type PlatformFeedbackCategory,
	type PlatformFeedbackRecord,
	type PlatformFeedbackRow,
	type PlatformFeedbackStatus,
} from './types.ts'

const maxSummaryLength = 200
const maxDetailsLength = 8_000
const maxAdminNoteLength = 2_000
const defaultPageSize = 20
const maxPageSize = 100
const activeQueueLimit = 100
const submissionRateLimitConfig = {
	maxRequests: 10,
	windowSeconds: 24 * 60 * 60,
}

function normalizeRequiredText(
	value: string,
	input: { field: string; maxLength: number },
) {
	const normalized = value.trim()
	if (normalized.length < 1 || normalized.length > input.maxLength) {
		throw new Error(
			`${input.field} must contain between 1 and ${input.maxLength} characters.`,
		)
	}
	return normalized
}

function normalizeAdminNote(
	adminNote: string | undefined,
): string | null | undefined {
	if (adminNote === undefined) return undefined
	const normalized = adminNote.trim()
	if (normalized.length > maxAdminNoteLength) {
		throw new Error(
			`admin_note must contain at most ${maxAdminNoteLength} characters.`,
		)
	}
	return normalized.length > 0 ? normalized : null
}

function normalizePage(value: number | undefined) {
	if (value === undefined || !Number.isFinite(value)) return 1
	return Math.max(1, Math.trunc(value))
}

function normalizePageSize(value: number | undefined) {
	if (value === undefined || !Number.isFinite(value)) return defaultPageSize
	return Math.min(maxPageSize, Math.max(1, Math.trunc(value)))
}

function invalidTransition(input: {
	feedbackId: string
	status: PlatformFeedbackStatus
	action: PlatformFeedbackAction
}): never {
	throw new PlatformFeedbackInvalidTransitionError(input)
}

function planTransition(input: {
	feedbackId: string
	status: PlatformFeedbackStatus
	action: PlatformFeedbackAction
}): PlatformFeedbackStatus | null {
	switch (input.action) {
		case 'triage': {
			switch (input.status) {
				case 'open':
					return 'triaged'
				case 'triaged':
					return null
				case 'resolved':
					return invalidTransition(input)
				case 'dismissed':
					return invalidTransition(input)
				default: {
					const exhaustive: never = input.status
					throw new Error(`Unsupported platform feedback status: ${exhaustive}`)
				}
			}
		}
		case 'resolve': {
			switch (input.status) {
				case 'open':
				case 'triaged':
					return 'resolved'
				case 'resolved':
					return null
				case 'dismissed':
					return invalidTransition(input)
				default: {
					const exhaustive: never = input.status
					throw new Error(`Unsupported platform feedback status: ${exhaustive}`)
				}
			}
		}
		case 'dismiss': {
			switch (input.status) {
				case 'open':
				case 'triaged':
					return 'dismissed'
				case 'dismissed':
					return null
				case 'resolved':
					return invalidTransition(input)
				default: {
					const exhaustive: never = input.status
					throw new Error(`Unsupported platform feedback status: ${exhaustive}`)
				}
			}
		}
		default: {
			const exhaustive: never = input.action
			throw new Error(`Unsupported platform feedback action: ${exhaustive}`)
		}
	}
}

export async function submitPlatformFeedback(input: {
	db: D1Database
	submitterUserId: string
	category: PlatformFeedbackCategory
	summary: string
	details: string
}): Promise<PlatformFeedbackRecord> {
	const submitterUserId = normalizeRequiredText(input.submitterUserId, {
		field: 'submitterUserId',
		maxLength: 1_000,
	})
	const summary = normalizeRequiredText(input.summary, {
		field: 'summary',
		maxLength: maxSummaryLength,
	})
	const details = normalizeRequiredText(input.details, {
		field: 'details',
		maxLength: maxDetailsLength,
	})
	const now = new Date().toISOString()
	const feedbackId = crypto.randomUUID()
	const row: PlatformFeedbackRow = {
		id: feedbackId,
		submitter_user_id: submitterUserId,
		category: input.category,
		summary,
		details,
		status: 'open',
		reviewed_by_user_id: null,
		reviewed_at: null,
		admin_note: null,
		created_at: now,
		updated_at: now,
	}
	const rateLimitKey = `platform-feedback:submit:user:${submitterUserId}`
	const rateLimit = await checkRateLimit(
		input.db,
		rateLimitKey,
		submissionRateLimitConfig,
	)
	if (!rateLimit.allowed) {
		throw new PlatformFeedbackSubmissionRateLimitError(
			rateLimit.retryAfterSeconds ?? submissionRateLimitConfig.windowSeconds,
		)
	}
	try {
		const inserted = await insertPlatformFeedback(
			input.db,
			row,
			activeQueueLimit,
		)
		if (!inserted) {
			throw new PlatformFeedbackActiveQueueLimitError(activeQueueLimit)
		}
	} catch (error) {
		await releaseRateLimit(input.db, rateLimitKey).catch(() => undefined)
		throw error
	}
	return {
		id: row.id,
		submitterUserId: row.submitter_user_id,
		category: row.category,
		summary: row.summary,
		details: row.details,
		status: row.status,
		reviewedByUserId: row.reviewed_by_user_id,
		reviewedAt: row.reviewed_at,
		adminNote: row.admin_note,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

export async function listPlatformFeedbackForAdmin(input: {
	db: D1Database
	page?: number
	pageSize?: number
	status?: PlatformFeedbackStatus
	category?: PlatformFeedbackCategory
}) {
	const page = normalizePage(input.page)
	const pageSize = normalizePageSize(input.pageSize)
	const result = await listPlatformFeedbackRowsForAdmin(input.db, {
		page,
		pageSize,
		status: input.status,
		category: input.category,
	})
	return { ...result, page, pageSize }
}

export async function getPlatformFeedbackForAdmin(input: {
	db: D1Database
	feedbackId: string
}) {
	return getPlatformFeedbackByIdForAdmin(input.db, input.feedbackId)
}

export async function updatePlatformFeedbackForAdmin(input: {
	db: D1Database
	feedbackId: string
	reviewerUserId: string
	action: PlatformFeedbackAction
	adminNote?: string
}): Promise<PlatformFeedbackRecord> {
	const reviewerUserId = normalizeRequiredText(input.reviewerUserId, {
		field: 'reviewerUserId',
		maxLength: 1_000,
	})
	const adminNote = normalizeAdminNote(input.adminNote)
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const existing = await getPlatformFeedbackByIdForAdmin(
			input.db,
			input.feedbackId,
		)
		if (!existing) {
			throw new PlatformFeedbackNotFoundError(input.feedbackId)
		}
		const nextStatus = planTransition({
			feedbackId: input.feedbackId,
			status: existing.status,
			action: input.action,
		})
		const adminNoteChanged =
			adminNote !== undefined && adminNote !== existing.adminNote
		if (nextStatus === null && !adminNoteChanged) return existing
		const reviewedAt = new Date().toISOString()
		const updated = await updatePlatformFeedbackStatusForAdmin(input.db, {
			feedbackId: input.feedbackId,
			expectedStatus: existing.status,
			status: nextStatus ?? existing.status,
			reviewedByUserId: reviewerUserId,
			reviewedAt,
			adminNote,
		})
		if (!updated) continue
		const feedback = await getPlatformFeedbackByIdForAdmin(
			input.db,
			input.feedbackId,
		)
		if (!feedback) {
			throw new PlatformFeedbackNotFoundError(input.feedbackId)
		}
		return feedback
	}
	throw new PlatformFeedbackConcurrentUpdateError(input.feedbackId)
}
