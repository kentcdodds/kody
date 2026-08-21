export const userCreatedTopic = 'user.created'
export const userDeletedTopic = 'user.deleted'

export const userLifecycleEventTopics = [
	userCreatedTopic,
	userDeletedTopic,
] as const

export type UserCreatedTopic = typeof userCreatedTopic
export type UserDeletedTopic = typeof userDeletedTopic
export type UserLifecycleEventTopic = (typeof userLifecycleEventTopics)[number]

export const userCreatedSources = ['signup', 'oauth', 'admin'] as const
export type UserCreatedSource = (typeof userCreatedSources)[number]

export type UserLifecycleIdentity = {
	id: string
	username: string
	email: string
}

export type UserCreatedEvent = {
	event: UserCreatedTopic
	user: UserLifecycleIdentity
	source: UserCreatedSource
	created_at: string
}

export type UserDeletedEvent = {
	event: UserDeletedTopic
	user: UserLifecycleIdentity
	deleted_at: string
}

export type UserLifecycleEvent = UserCreatedEvent | UserDeletedEvent

export function isUserLifecycleEventTopic(
	value: string,
): value is UserLifecycleEventTopic {
	return (userLifecycleEventTopics as ReadonlyArray<string>).includes(value)
}

export function buildUserCreatedEvent(input: {
	user: UserLifecycleIdentity
	source: UserCreatedSource
	createdAt: string
}): UserCreatedEvent {
	return {
		event: userCreatedTopic,
		user: input.user,
		source: input.source,
		created_at: input.createdAt,
	}
}

export function buildUserDeletedEvent(input: {
	user: UserLifecycleIdentity
	deletedAt: string
}): UserDeletedEvent {
	return {
		event: userDeletedTopic,
		user: input.user,
		deleted_at: input.deletedAt,
	}
}

export function buildUserLifecycleIdempotencyKey(input: {
	event: UserLifecycleEvent
	packageId: string
}) {
	switch (input.event.event) {
		case userCreatedTopic:
			return `user-lifecycle:${input.event.event}:${input.event.user.id}:${input.event.created_at}:${input.packageId}`
		case userDeletedTopic:
			return `user-lifecycle:${input.event.event}:${input.event.user.id}:${input.event.deleted_at}:${input.packageId}`
		default: {
			const exhaustive: never = input.event
			throw new Error(`Unsupported user lifecycle event: ${String(exhaustive)}`)
		}
	}
}
