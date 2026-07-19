import {
	type PlatformFeedbackAction,
	type PlatformFeedbackStatus,
} from './types.ts'

export class PlatformFeedbackNotFoundError extends Error {
	constructor(feedbackId: string) {
		super(`Platform feedback "${feedbackId}" was not found.`)
		this.name = 'PlatformFeedbackNotFoundError'
	}
}

export class PlatformFeedbackInvalidTransitionError extends Error {
	constructor(input: {
		feedbackId: string
		status: PlatformFeedbackStatus
		action: PlatformFeedbackAction
	}) {
		super(
			`Cannot ${input.action} platform feedback "${input.feedbackId}" from status "${input.status}". Terminal feedback cannot change to another status.`,
		)
		this.name = 'PlatformFeedbackInvalidTransitionError'
	}
}

export class PlatformFeedbackConcurrentUpdateError extends Error {
	constructor(feedbackId: string) {
		super(
			`Platform feedback "${feedbackId}" changed concurrently. Read it again and retry the requested action.`,
		)
		this.name = 'PlatformFeedbackConcurrentUpdateError'
	}
}

export type PlatformFeedbackDomainError =
	| PlatformFeedbackNotFoundError
	| PlatformFeedbackInvalidTransitionError
	| PlatformFeedbackConcurrentUpdateError

export function isPlatformFeedbackDomainError(
	error: unknown,
): error is PlatformFeedbackDomainError {
	return (
		error instanceof PlatformFeedbackNotFoundError ||
		error instanceof PlatformFeedbackInvalidTransitionError ||
		error instanceof PlatformFeedbackConcurrentUpdateError
	)
}
