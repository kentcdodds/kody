export const platformFeedbackCategories = [
	'friction',
	'bug',
	'experience',
	'suggestion',
	'other',
] as const

export type PlatformFeedbackCategory =
	(typeof platformFeedbackCategories)[number]

export const platformFeedbackStatuses = [
	'open',
	'triaged',
	'resolved',
	'dismissed',
] as const

export type PlatformFeedbackStatus = (typeof platformFeedbackStatuses)[number]

export const platformFeedbackActions = ['triage', 'resolve', 'dismiss'] as const

export type PlatformFeedbackAction = (typeof platformFeedbackActions)[number]

export type PlatformFeedbackRow = {
	id: string
	submitter_user_id: string
	submitter_username: string | null
	submitter_email: string | null
	category: PlatformFeedbackCategory
	summary: string
	details: string
	status: PlatformFeedbackStatus
	reviewed_by_user_id: string | null
	reviewed_at: string | null
	admin_note: string | null
	created_at: string
	updated_at: string
}

export type PlatformFeedbackRecord = {
	id: string
	submitterUserId: string
	submitterUsername: string | null
	submitterEmail: string | null
	category: PlatformFeedbackCategory
	summary: string
	details: string
	status: PlatformFeedbackStatus
	reviewedByUserId: string | null
	reviewedAt: string | null
	adminNote: string | null
	createdAt: string
	updatedAt: string
}

/** Internal full-record shape used for optimistic admin updates. */
export type PlatformFeedbackRecordWithRevision = PlatformFeedbackRecord & {
	revision: number
}

export type PlatformFeedbackListItem = Omit<
	PlatformFeedbackRecord,
	'details' | 'adminNote' | 'submitterUsername' | 'submitterEmail'
>
