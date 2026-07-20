export class CommunityActionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CommunityActionError'
	}
}

export class CommunityActivityDispatchCancelledError extends Error {
	readonly kind: string
	readonly activityId: string

	constructor(input: { kind: string; activityId: string }) {
		super(
			`Community ${input.kind} activity "${input.activityId}" no longer exists.`,
		)
		this.name = 'CommunityActivityDispatchCancelledError'
		this.kind = input.kind
		this.activityId = input.activityId
	}
}
