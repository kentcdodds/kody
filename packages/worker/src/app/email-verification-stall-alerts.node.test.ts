import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { userEmailVerificationStalledTopic } from '#worker/identity/email-verification-stalled-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchUserEmailVerificationStalledSubscriptionEvent: vi.fn(async () => []),
}))

vi.mock(
	'#worker/identity/email-verification-stalled-package-subscriptions.ts',
	() => ({
		dispatchUserEmailVerificationStalledSubscriptionEvent:
			mocks.dispatchUserEmailVerificationStalledSubscriptionEvent,
	}),
)

const {
	checkEmailVerificationStallsAndNotify,
	shouldRunEmailVerificationStallAlertCron,
} = await import('./email-verification-stall-alerts.ts')

async function seedUser(input: {
	db: D1Database
	username: string
	email: string
	stableUserId: string
	verifiedAt?: string | null
	accountType?: 'person' | 'platform'
	deletingAt?: string | null
	deliveryStatus?: string | null
	deliveryAt?: string | null
}) {
	await input.db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, email_verified_at,
				account_type, deleting_at, email_verification_delivery_status,
				email_verification_delivery_at
			) VALUES (?, ?, 'hash', ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.username,
			input.email,
			input.stableUserId,
			input.verifiedAt ?? null,
			input.accountType ?? 'person',
			input.deletingAt ?? null,
			input.deliveryStatus ?? null,
			input.deliveryAt ?? null,
		)
		.run()
}

test('hourly stall scan fans accepted sends older than the threshold and skips fresh or resolved rows', async () => {
	expect(
		shouldRunEmailVerificationStallAlertCron(
			new Date('2026-09-01T10:00:00.000Z'),
		),
	).toBe(true)
	expect(
		shouldRunEmailVerificationStallAlertCron(
			new Date('2026-09-01T10:05:00.000Z'),
		),
	).toBe(false)

	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({
		db,
		columns: ['email_verified_at', 'account_type'],
	})
	await seedUser({
		db,
		username: 'raul',
		email: 'a.kodycodes@raulg.dev',
		stableUserId: 'r'.repeat(64),
		deliveryStatus: 'accepted',
		deliveryAt: '2026-09-01T08:45:16.921Z',
	})
	await seedUser({
		db,
		username: 'fresh',
		email: 'fresh@example.com',
		stableUserId: 'f'.repeat(64),
		deliveryStatus: 'accepted',
		deliveryAt: '2026-09-01T09:30:00.000Z',
	})
	await seedUser({
		db,
		username: 'verified',
		email: 'verified@example.com',
		stableUserId: 'v'.repeat(64),
		verifiedAt: '2026-09-01T09:00:00.000Z',
		deliveryStatus: 'accepted',
		deliveryAt: '2026-09-01T08:00:00.000Z',
	})
	await seedUser({
		db,
		username: 'bounced',
		email: 'bounced@example.com',
		stableUserId: 'b'.repeat(64),
		deliveryStatus: 'bounced',
		deliveryAt: '2026-09-01T08:00:00.000Z',
	})
	await seedUser({
		db,
		username: 'platform',
		email: 'ops@kody.codes',
		stableUserId: 'p'.repeat(64),
		accountType: 'platform',
		deliveryStatus: 'accepted',
		deliveryAt: '2026-09-01T08:00:00.000Z',
	})
	await seedUser({
		db,
		username: 'leaving',
		email: 'leaving@example.com',
		stableUserId: 'l'.repeat(64),
		deletingAt: '2026-09-01T09:00:00.000Z',
		deliveryStatus: 'accepted',
		deliveryAt: '2026-09-01T08:00:00.000Z',
	})

	const env = {
		APP_DB: db,
		APP_BASE_URL: 'https://kody.codes',
	}
	const now = new Date('2026-09-01T10:00:00.000Z')
	const result = await checkEmailVerificationStallsAndNotify({ env, now })

	expect(result).toEqual({ scanned: 1, notified: 1, failed: 0 })
	expect(
		mocks.dispatchUserEmailVerificationStalledSubscriptionEvent,
	).toHaveBeenCalledOnce()
	expect(
		mocks.dispatchUserEmailVerificationStalledSubscriptionEvent,
	).toHaveBeenCalledWith({
		env,
		event: expect.objectContaining({
			event: userEmailVerificationStalledTopic,
			user: {
				id: 'r'.repeat(64),
				username: 'raul',
				email: 'a.kodycodes@raulg.dev',
			},
			status: 'accepted',
			accepted_at: '2026-09-01T08:45:16.921Z',
			stall_after_minutes: 60,
			admin_user_url: `https://kody.codes/admin/users/${'r'.repeat(64)}`,
			occurred_at: '2026-09-01T10:00:00.000Z',
		}),
	})
})
