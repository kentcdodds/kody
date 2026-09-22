import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { getUserEntitlement } from './service.ts'
import {
	evaluateSecondAgentStandardGift,
	maybeEvaluateSecondAgentStandardGift,
} from './second-agent-standard-gift.ts'

const secondAgentStandardGiftDurationMs = 14 * 24 * 60 * 60 * 1000
// Grant yesterday so the wall-clock entitlement read still sees an active gift.
// A fixed 2026-09-21 expiry goes stale the afternoon it lands.
const now = new Date(Date.now() - 24 * 60 * 60 * 1000)
const giftExpiresAt = new Date(
	now.getTime() + secondAgentStandardGiftDurationMs,
).toISOString()

async function createGiftTestDb(input: {
	email: string
	plan?: string
	stripePlan?: string | null
}) {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({
		db,
		columns: ['stripe_plan'],
	})
	const stableUserId = testStableUserIdFromEmail(input.email)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, plan, stripe_plan)
			 VALUES (?, ?, 'hash', ?, ?, ?)`,
		)
		.bind(
			input.email.split('@')[0],
			input.email,
			stableUserId,
			input.plan ?? 'free',
			input.stripePlan ?? null,
		)
		.run()
	return { db, stableUserId }
}

test('first second-ecosystem grant gives 14-day Standard; later events and paid tiers do not', async () => {
	// The gift's stored expiry is 2026-09-21. Entitlement reads the wall
	// clock, so pin it to the scenario date or the gift looks expired.
	vi.useFakeTimers({ now })
	try {
		await assertSecondAgentGiftOnScenarioClock()
	} finally {
		vi.useRealTimers()
	}
})

async function assertSecondAgentGiftOnScenarioClock() {
	const free = await createGiftTestDb({
		email: 'free-gift@example.com',
	})

	expect(
		await evaluateSecondAgentStandardGift({
			db: free.db,
			stableUserId: free.stableUserId,
			ecosystemCount: 1,
			now,
		}),
	).toEqual({ outcome: 'below_threshold' })
	expect(
		await getUserEntitlement(free.db, {
			userId: free.stableUserId,
			email: 'free-gift@example.com',
		}),
	).toEqual({ plan: 'free', ladder: 'public' })

	const first = await evaluateSecondAgentStandardGift({
		db: free.db,
		stableUserId: free.stableUserId,
		ecosystemCount: 2,
		now,
	})
	expect(first).toEqual({
		outcome: 'granted',
		gift: {
			received: true,
			active: true,
			status: 'active',
			grantedAt: now.toISOString(),
			expiresAt: giftExpiresAt,
		},
	})
	// The gift fixture expires at noon UTC on 2026-09-21. Entitlement reads
	// the wall clock, so pin it to the grant time or this assertion flips
	// to free once that noon has passed.
	vi.useFakeTimers()
	vi.setSystemTime(now)
	try {
		expect(
			await getUserEntitlement(free.db, {
				userId: free.stableUserId,
				email: 'free-gift@example.com',
			}),
		).toEqual({ plan: 'standard', ladder: 'public' })
	} finally {
		vi.useRealTimers()
	}

	const second = await evaluateSecondAgentStandardGift({
		db: free.db,
		stableUserId: free.stableUserId,
		ecosystemCount: 3,
		now: new Date(now.getTime() + 24 * 60 * 60 * 1000),
	})
	expect(second.outcome).toBe('already_granted')
	if (second.outcome !== 'already_granted') {
		throw new Error('expected already_granted')
	}
	expect(second.gift.expiresAt).toBe(giftExpiresAt)
	expect(second.gift.grantedAt).toBe(now.toISOString())

	const stored = await free.db
		.prepare(
			`SELECT second_agent_standard_gift_granted_at,
			        second_agent_standard_gift_expires_at
			 FROM users WHERE stable_user_id = ?`,
		)
		.bind(free.stableUserId)
		.first<{
			second_agent_standard_gift_granted_at: string
			second_agent_standard_gift_expires_at: string
		}>()
	expect(stored).toEqual({
		second_agent_standard_gift_granted_at: now.toISOString(),
		second_agent_standard_gift_expires_at: giftExpiresAt,
	})

	const paidStandard = await createGiftTestDb({
		email: 'paid-standard@example.com',
		stripePlan: 'standard',
	})
	const paidStandardGift = await evaluateSecondAgentStandardGift({
		db: paidStandard.db,
		stableUserId: paidStandard.stableUserId,
		ecosystemCount: 2,
		now,
	})
	expect(paidStandardGift).toEqual({
		outcome: 'granted',
		gift: {
			received: true,
			active: false,
			status: 'already_paid',
			grantedAt: now.toISOString(),
			expiresAt: null,
		},
	})
	expect(
		await getUserEntitlement(paidStandard.db, {
			userId: paidStandard.stableUserId,
			email: 'paid-standard@example.com',
		}),
	).toEqual({ plan: 'standard', ladder: 'public' })

	const paidPro = await createGiftTestDb({
		email: 'paid-pro@example.com',
		stripePlan: 'pro',
	})
	const paidProGift = await evaluateSecondAgentStandardGift({
		db: paidPro.db,
		stableUserId: paidPro.stableUserId,
		ecosystemCount: 2,
		now,
	})
	expect(paidProGift.outcome).toBe('granted')
	if (paidProGift.outcome !== 'granted') {
		throw new Error('expected granted')
	}
	expect(paidProGift.gift.status).toBe('already_paid')
	expect(paidProGift.gift.expiresAt).toBeNull()
	expect(
		await getUserEntitlement(paidPro.db, {
			userId: paidPro.stableUserId,
			email: 'paid-pro@example.com',
		}),
	).toEqual({ plan: 'pro', ladder: 'public' })

	const replayPaid = await evaluateSecondAgentStandardGift({
		db: paidPro.db,
		stableUserId: paidPro.stableUserId,
		ecosystemCount: 4,
		now,
	})
	expect(replayPaid.outcome).toBe('already_granted')
}

test('maybeEvaluate skips writes without prepare and keeps an existing gift below two clients', async () => {
	const warn = vi.spyOn(console, 'warn')
	await expect(
		maybeEvaluateSecondAgentStandardGift({
			db: {} as D1Database,
			stableUserId: 'user-1',
			ecosystemCount: 2,
		}),
	).resolves.toEqual({
		received: false,
		active: false,
		status: 'none',
		expiresAt: null,
		grantedAt: null,
	})
	expect(warn).not.toHaveBeenCalled()
	warn.mockRestore()

	const gifted = await createGiftTestDb({
		email: 'already-gifted@example.com',
	})
	await evaluateSecondAgentStandardGift({
		db: gifted.db,
		stableUserId: gifted.stableUserId,
		ecosystemCount: 2,
		now,
	})
	const afterRevoke = await maybeEvaluateSecondAgentStandardGift({
		db: gifted.db,
		stableUserId: gifted.stableUserId,
		ecosystemCount: 1,
		now,
	})
	expect(afterRevoke).toEqual({
		received: true,
		active: true,
		status: 'active',
		grantedAt: now.toISOString(),
		expiresAt: giftExpiresAt,
	})
	const afterFailedListing = await maybeEvaluateSecondAgentStandardGift({
		db: gifted.db,
		stableUserId: gifted.stableUserId,
		ecosystemCount: 2,
		listingFailed: true,
		now,
	})
	expect(afterFailedListing.status).toBe('active')
})
