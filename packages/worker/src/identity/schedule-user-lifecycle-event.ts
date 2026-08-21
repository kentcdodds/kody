import { waitUntil } from 'cloudflare:workers'
import { dispatchUserLifecycleSubscriptionEvent } from './user-lifecycle-package-subscriptions.ts'
import {
	buildUserCreatedEvent,
	buildUserDeletedEvent,
	type UserCreatedSource,
	type UserLifecycleIdentity,
} from './user-lifecycle-subscription-event.ts'

type UserLifecycleScheduleEnv = Pick<
	Env,
	'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
>

function scheduleUserLifecycleSubscriptionEvent(input: {
	env: UserLifecycleScheduleEnv
	event: Parameters<typeof dispatchUserLifecycleSubscriptionEvent>[0]['event']
}) {
	waitUntil(
		dispatchUserLifecycleSubscriptionEvent({
			env: input.env,
			event: input.event,
		}).catch((error) => {
			console.warn('user-lifecycle-subscription-dispatch-failed', {
				event: input.event.event,
				userId: input.event.user.id,
				error,
			})
		}),
	)
}

export function scheduleUserCreatedEvent(input: {
	env: UserLifecycleScheduleEnv
	user: UserLifecycleIdentity
	source: UserCreatedSource
	createdAt?: string
}) {
	scheduleUserLifecycleSubscriptionEvent({
		env: input.env,
		event: buildUserCreatedEvent({
			user: input.user,
			source: input.source,
			createdAt: input.createdAt ?? new Date().toISOString(),
		}),
	})
}

export function scheduleUserDeletedEvent(input: {
	env: UserLifecycleScheduleEnv
	user: UserLifecycleIdentity
	deletedAt?: string
}) {
	scheduleUserLifecycleSubscriptionEvent({
		env: input.env,
		event: buildUserDeletedEvent({
			user: input.user,
			deletedAt: input.deletedAt ?? new Date().toISOString(),
		}),
	})
}
