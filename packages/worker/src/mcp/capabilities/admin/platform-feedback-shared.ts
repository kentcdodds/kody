import { z } from 'zod'
import {
	platformFeedbackCategories,
	platformFeedbackStatuses,
	type PlatformFeedbackListItem,
	type PlatformFeedbackRecord,
} from '#worker/platform-feedback/types.ts'

export const platformFeedbackCategorySchema = z.enum(platformFeedbackCategories)

export const platformFeedbackStatusSchema = z.enum(platformFeedbackStatuses)

export const adminPlatformFeedbackListItemSchema = z.object({
	id: z.string(),
	submitter_user_id: z.string(),
	category: platformFeedbackCategorySchema,
	summary: z.string(),
	status: platformFeedbackStatusSchema,
	reviewed_by_user_id: z.string().nullable(),
	reviewed_at: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
})

export const adminPlatformFeedbackRecordSchema =
	adminPlatformFeedbackListItemSchema.extend({
		details: z.string(),
		admin_note: z.string().nullable(),
	})

export function formatAdminPlatformFeedbackListItem(
	feedback: PlatformFeedbackListItem,
) {
	return {
		id: feedback.id,
		submitter_user_id: feedback.submitterUserId,
		category: feedback.category,
		summary: feedback.summary,
		status: feedback.status,
		reviewed_by_user_id: feedback.reviewedByUserId,
		reviewed_at: feedback.reviewedAt,
		created_at: feedback.createdAt,
		updated_at: feedback.updatedAt,
	}
}

export function formatAdminPlatformFeedbackRecord(
	feedback: PlatformFeedbackRecord,
) {
	return {
		...formatAdminPlatformFeedbackListItem(feedback),
		details: feedback.details,
		admin_note: feedback.adminNote,
	}
}
