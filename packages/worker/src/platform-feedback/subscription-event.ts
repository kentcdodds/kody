import {
	type PlatformFeedbackCategory,
	type PlatformFeedbackRecord,
} from './types.ts'

export const platformFeedbackSubmittedTopic = 'platform.feedback.submitted'

export type PlatformFeedbackSubmittedEvent = {
	event: typeof platformFeedbackSubmittedTopic
	feedback: {
		id: string
		category: PlatformFeedbackCategory
		status: 'open'
		created_at: string
	}
}

export function buildPlatformFeedbackSubmittedEvent(
	feedback: Pick<PlatformFeedbackRecord, 'id' | 'category' | 'createdAt'>,
): PlatformFeedbackSubmittedEvent {
	return {
		event: platformFeedbackSubmittedTopic,
		feedback: {
			id: feedback.id,
			category: feedback.category,
			status: 'open',
			created_at: feedback.createdAt,
		},
	}
}
