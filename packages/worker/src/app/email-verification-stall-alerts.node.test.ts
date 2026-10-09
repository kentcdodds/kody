import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { userEmailVerificationStalledTopic } from '#worker/identity/email-verification-stalled-subscription-event.ts'

const mocks = vi.hoisted(() => ({
	dispatchUserEmailVerificationStalledSubscriptionEvent: vi.fn(
		async (_input: { event: { user: { username: string } } }) => [],
	),
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

type SeedUser = {
	username: string
	email?: string
	stableUserId: string
	verifiedAt?: string | null
	accountType?: 'person' | 'platform'
	deletingAt?: string | null
	deliveryStatus?: string | null
	deliveryAt?: string | null
}

/** Users table with `accepted` verification sends unless overridden. */
async function createUsersDb(users: Array<SeedUser>) {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	await ensureUsersTestSchema({
		db,
		columns: ['email_verified_at', 'account_type'],
	})
	for (const user of users) {
		await db
			.prepare(
				`INSERT INTO users (
					username, email, password_hash, stable_user_id, email_verified_at,
					account_type, deleting_at, email_verification_delivery_status,
					email_verification_delivery_at
				) VALUES (?, ?, 'hash', ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				user.username,
				user.email ?? `${user.username}@example.com`,
				user.stableUserId,
				user.verifiedAt ?? null,
				user.accountType ?? 'person',
				user.deletingAt ?? null,
				user.deliveryStatus ?? 'accepted',
				user.deliveryAt ?? '2026-09-01T08:00:00.000Z',
			)
			.run()
	}
	return db
}

const dispatchStalled =
	mocks.dispatchUserEmailVerificationStalledSubscriptionEvent

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

	const db = await createUsersDb([
		{
			username: 'raul',
			email: 'a.kodycodes@raulg.dev',
			stableUserId: 'r'.repeat(64),
			deliveryAt: '2026-09-01T08:45:16.921Z',
		},
		{
			username: 'fresh',
			stableUserId: 'f'.repeat(64),
			deliveryAt: '2026-09-01T09:30:00.000Z',
		},
		{
			username: 'verified',
			stableUserId: 'v'.repeat(64),
			verifiedAt: '2026-09-01T09:00:00.000Z',
		},
		{
			username: 'bounced',
			stableUserId: 'b'.repeat(64),
			deliveryStatus: 'bounced',
		},
		{
			username: 'platform',
			email: 'ops@kody.codes',
			stableUserId: 'p'.repeat(64),
			accountType: 'platform',
		},
		{
			username: 'leaving',
			stableUserId: 'l'.repeat(64),
			deletingAt: '2026-09-01T09:00:00.000Z',
		},
	])
	const env = { APP_DB: db, APP_BASE_URL: 'https://kody.codes' }
	const result = await checkEmailVerificationStallsAndNotify({
		env,
		now: new Date('2026-09-01T10:00:00.000Z'),
	})

	expect(result).toEqual({ scanned: 1, notified: 1, failed: 0 })
	expect(dispatchStalled).toHaveBeenCalledOnce()
	expect(dispatchStalled).toHaveBeenCalledWith({
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

function createMemoryKv() {
	const store = new Map<string, string>()
	return {
		async get(key: string) {
			return store.get(key) ?? null
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
	} as unknown as KVNamespace
}

test('hourly stall scan advances a watermark so later accepted sends are not starved', async () => {
	const env = {
		APP_DB: await createUsersDb([
			{
				username: 'older',
				stableUserId: 'a'.repeat(64),
				deliveryAt: '2026-09-01T07:00:00.000Z',
			},
			{ username: 'newer', stableUserId: 'n'.repeat(64) },
		]),
		APP_BASE_URL: 'https://kody.codes',
		BUNDLE_ARTIFACTS_KV: createMemoryKv(),
	}
	for (const [now, username] of [
		['2026-09-01T10:00:00.000Z', 'older'],
		['2026-09-01T11:00:00.000Z', 'newer'],
	] as const) {
		expect(
			await checkEmailVerificationStallsAndNotify({
				env,
				now: new Date(now),
				scanLimit: 1,
			}),
		).toEqual({ scanned: 1, notified: 1, failed: 0 })
		expect(dispatchStalled.mock.calls.at(-1)?.[0].event.user.username).toBe(
			username,
		)
	}
})
