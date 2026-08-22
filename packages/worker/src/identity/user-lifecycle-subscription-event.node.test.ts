import { expect, test } from 'vitest'
import {
	buildUserCreatedEvent,
	buildUserDeletedEvent,
	buildUserLifecycleIdempotencyKey,
	isUserLifecycleEventTopic,
	userCreatedTopic,
	userDeletedTopic,
} from './user-lifecycle-subscription-event.ts'

test('user lifecycle event builders keep a metadata-only identity snapshot', () => {
	const created = buildUserCreatedEvent({
		user: {
			id: 'user-1',
			username: 'ada',
			email: 'ada@example.com',
		},
		source: 'signup',
		createdAt: '2026-08-20T12:00:00.000Z',
	})
	const deleted = buildUserDeletedEvent({
		user: created.user,
		deletedAt: '2026-08-20T13:00:00.000Z',
	})

	expect(created).toEqual({
		event: userCreatedTopic,
		user: {
			id: 'user-1',
			username: 'ada',
			email: 'ada@example.com',
		},
		source: 'signup',
		created_at: '2026-08-20T12:00:00.000Z',
	})
	expect(deleted).toEqual({
		event: userDeletedTopic,
		user: created.user,
		deleted_at: '2026-08-20T13:00:00.000Z',
	})
	expect(isUserLifecycleEventTopic(userCreatedTopic)).toBe(true)
	expect(isUserLifecycleEventTopic(userDeletedTopic)).toBe(true)
	expect(isUserLifecycleEventTopic('user.updated')).toBe(false)
	expect(
		buildUserLifecycleIdempotencyKey({
			event: created,
			packageId: 'package-1',
		}),
	).toBe(
		'user-lifecycle:user.created:user-1:2026-08-20T12:00:00.000Z:package-1',
	)
	expect(
		buildUserLifecycleIdempotencyKey({
			event: deleted,
			packageId: 'package-1',
		}),
	).toBe(
		'user-lifecycle:user.deleted:user-1:2026-08-20T13:00:00.000Z:package-1',
	)
})
