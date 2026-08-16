import { expect, test } from 'vitest'
import {
	isRepoSessionDue,
	nextOwnerDueAt,
	nextOwnerDueAtFromBounds,
	nextRepoSessionDueAt,
	repoSessionFarFutureDueAt,
} from './repo-session-due.ts'

test('due helpers treat unused leftovers sooner than edited sessions', () => {
	const now = new Date('2026-06-24T20:00:00.000Z')
	expect(
		isRepoSessionDue(
			{
				status: 'active',
				last_checkpoint_at: null,
				updated_at: '2026-06-24T19:00:00.000Z',
				expires_at: null,
			},
			now,
		),
	).toBe(true)
	expect(
		isRepoSessionDue(
			{
				status: 'active',
				last_checkpoint_at: null,
				updated_at: '2026-06-24T19:45:00.000Z',
				expires_at: null,
			},
			now,
		),
	).toBe(false)
	expect(
		isRepoSessionDue(
			{
				status: 'active',
				last_checkpoint_at: '2026-06-20T20:00:00.000Z',
				updated_at: '2026-06-20T20:00:00.000Z',
				expires_at: null,
			},
			now,
		),
	).toBe(false)
	expect(
		isRepoSessionDue(
			{
				status: 'active',
				last_checkpoint_at: '2026-06-16T20:00:00.000Z',
				updated_at: '2026-06-16T20:00:00.000Z',
				expires_at: null,
			},
			now,
		),
	).toBe(true)
	expect(
		isRepoSessionDue(
			{
				status: 'published',
				last_checkpoint_at: '2026-06-24T10:00:00.000Z',
				updated_at: '2026-06-24T10:00:00.000Z',
				expires_at: '2026-06-24T12:00:00.000Z',
			},
			now,
		),
	).toBe(true)
	expect(
		isRepoSessionDue(
			{
				status: 'published',
				last_checkpoint_at: '2026-06-24T10:00:00.000Z',
				updated_at: '2026-06-24T10:00:00.000Z',
				expires_at: '2026-06-25T12:00:00.000Z',
			},
			now,
		),
	).toBe(false)
	expect(
		nextRepoSessionDueAt({
			status: 'active',
			last_checkpoint_at: null,
			updated_at: '2026-06-24T19:00:00.000Z',
			expires_at: null,
		}),
	).toBe('2026-06-24T19:30:00.000Z')
	expect(
		nextOwnerDueAt([
			{
				status: 'active',
				last_checkpoint_at: null,
				updated_at: '2026-06-24T19:00:00.000Z',
				expires_at: null,
			},
			{
				status: 'published',
				last_checkpoint_at: '2026-06-24T10:00:00.000Z',
				updated_at: '2026-06-24T10:00:00.000Z',
				expires_at: '2026-06-24T12:00:00.000Z',
			},
		]),
	).toBe('2026-06-24T12:00:00.000Z')
	expect(
		nextOwnerDueAtFromBounds({
			unusedMinUpdatedAt: '2026-06-24T19:00:00.000Z',
			editedMinUpdatedAt: null,
			minExpiresAt: '2026-06-24T12:00:00.000Z',
			hasRows: true,
			pendingPurge: false,
		}),
	).toBe('2026-06-24T12:00:00.000Z')
	expect(
		nextOwnerDueAtFromBounds({
			unusedMinUpdatedAt: null,
			editedMinUpdatedAt: null,
			minExpiresAt: null,
			hasRows: false,
			pendingPurge: false,
		}),
	).toBeNull()
	expect(
		nextOwnerDueAtFromBounds({
			unusedMinUpdatedAt: null,
			editedMinUpdatedAt: null,
			minExpiresAt: null,
			hasRows: true,
			pendingPurge: false,
		}),
	).toBe(repoSessionFarFutureDueAt)
	expect(
		nextOwnerDueAtFromBounds({
			unusedMinUpdatedAt: null,
			editedMinUpdatedAt: null,
			minExpiresAt: null,
			hasRows: false,
			pendingPurge: true,
			now: new Date('2026-08-16T06:00:00.000Z'),
		}),
	).toBe('2026-08-16T06:00:00.000Z')
})
