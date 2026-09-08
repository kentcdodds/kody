export class CommunityActionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CommunityActionError'
	}
}

/**
 * User-facing copy when a community fork/install dies on isolate memory,
 * CPU reset, or Artifacts `MEMORY_LIMIT`. The listing is unchanged: no
 * fork row, no increment. Keep internals on the cause / Sentry, not here.
 */
export const communityForkResourceLimitMessage =
	'This package is too large to finish forking. Nothing was copied into your account, and the listing fork count did not change. Try again in a moment.'

export class CommunityForkResourceLimitError extends Error {
	override readonly name = 'CommunityForkResourceLimitError'

	constructor(cause?: unknown) {
		super(
			communityForkResourceLimitMessage,
			cause === undefined ? undefined : { cause },
		)
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

export class CommunityListingPublishedDispatchCancelledError extends Error {
	readonly listingId: string

	constructor(listingId: string) {
		super(
			`Community listing "${listingId}" is no longer active for published-event dispatch.`,
		)
		this.name = 'CommunityListingPublishedDispatchCancelledError'
		this.listingId = listingId
	}
}
