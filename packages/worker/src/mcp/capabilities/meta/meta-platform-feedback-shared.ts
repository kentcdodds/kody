import { z } from 'zod'
import {
	platformFeedbackCategories,
	platformFeedbackStatuses,
	type PlatformFeedbackSubmitterListItem,
	type PlatformFeedbackSubmitterRecord,
} from '#worker/platform-feedback/types.ts'

export const metaPlatformFeedbackCategorySchema = z.enum(
	platformFeedbackCategories,
)

export const metaPlatformFeedbackStatusSchema = z.enum(platformFeedbackStatuses)

/**
 * Submitter-visible list fields. Same column names as account export after
 * reviewer redaction; omits details (list) and never includes reviewer/admin
 * columns. For resolved/dismissed rows, `updated_at` is the outcome time.
 */
export const metaPlatformFeedbackListItemSchema = z.object({
	id: z.string(),
	category: metaPlatformFeedbackCategorySchema,
	summary: z.string(),
	status: metaPlatformFeedbackStatusSchema,
	created_at: z.string(),
	updated_at: z.string(),
})

export const metaPlatformFeedbackRecordSchema =
	metaPlatformFeedbackListItemSchema.extend({
		details: z.string(),
	})

export function formatMetaPlatformFeedbackListItem(
	feedback: PlatformFeedbackSubmitterListItem,
) {
	return {
		id: feedback.id,
		category: feedback.category,
		summary: feedback.summary,
		status: feedback.status,
		created_at: feedback.createdAt,
		updated_at: feedback.updatedAt,
	}
}

export function formatMetaPlatformFeedbackRecord(
	feedback: PlatformFeedbackSubmitterRecord,
) {
	return {
		...formatMetaPlatformFeedbackListItem(feedback),
		details: feedback.details,
	}
}
