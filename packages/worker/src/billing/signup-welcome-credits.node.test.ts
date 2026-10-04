import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import {
	microUsdPerCent,
	signupWelcomeCreditCents,
	signupWelcomeCreditLedgerId,
} from '#universal/credits.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	grantSignupWelcomeCredits,
	maybeGrantSignupWelcomeCredits,
	reconcileSignupWelcomeCreditsIfPending,
} from './signup-welcome-credits.ts'

const now = new Date('2026-10-04T12:00:00.000Z')

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function seedUser(
	sqlite: DatabaseSync,
	input: {
		stableUserId: string
		email: string
		username: string
		pending?: boolean
	},
) {
	sqlite
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id,
				signup_welcome_credits_pending, email_verified_at
			) VALUES (?, ?, 'hash', ?, ?, ?)`,
		)
		.run(
			input.username,
			input.email,
			input.stableUserId,
			input.pending ? 1 : 0,
			now.toISOString(),
		)
}

function pendingFlag(sqlite: DatabaseSync, stableUserId: string) {
	return (
		sqlite
			.prepare(
				`SELECT signup_welcome_credits_pending AS pending
				 FROM users WHERE stable_user_id = ?`,
			)
			.get(stableUserId) as { pending: number } | undefined
	)?.pending
}

function ledgerCount(sqlite: DatabaseSync, stableUserId: string) {
	return (
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM credit_ledger_entries WHERE user_id = ?`,
			)
			.get(stableUserId) as { count: number }
	).count
}

function walletBalance(sqlite: DatabaseSync, stableUserId: string) {
	return (
		(
			sqlite
				.prepare(
					`SELECT balance_micro_usd AS balance FROM credit_wallets WHERE user_id = ?`,
				)
				.get(stableUserId) as { balance: number } | undefined
		)?.balance ?? 0
	)
}

afterEach(() => {
	vi.restoreAllMocks()
})

test('failed creation-time grant marks pending; login reconcile grants once without double-crediting', async () => {
	const { sqlite, db } = createDb()
	const stableUserId = 'stable-welcome-retry'
	seedUser(sqlite, {
		stableUserId,
		email: 'welcome-retry@example.com',
		username: 'welcome-retry',
	})

	const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const failingDb = {
		prepare: db.prepare.bind(db),
		batch: async () => {
			throw new Error('D1 unavailable')
		},
	} as unknown as D1Database

	expect(
		await maybeGrantSignupWelcomeCredits({
			db: failingDb,
			userId: stableUserId,
			now,
		}),
	).toBeNull()
	expect(pendingFlag(sqlite, stableUserId)).toBe(1)
	expect(ledgerCount(sqlite, stableUserId)).toBe(0)
	expect(consoleWarn).toHaveBeenCalledWith(
		'signup-welcome-credits-failed',
		expect.any(Error),
	)

	const reconciled = await reconcileSignupWelcomeCreditsIfPending({
		db,
		userId: stableUserId,
		now,
	})
	expect(reconciled).toEqual({
		applied: true,
		entryId: signupWelcomeCreditLedgerId(stableUserId),
		balanceMicroUsd: signupWelcomeCreditCents * microUsdPerCent,
		createdAt: now.toISOString(),
	})
	expect(pendingFlag(sqlite, stableUserId)).toBe(0)
	expect(ledgerCount(sqlite, stableUserId)).toBe(1)
	expect(walletBalance(sqlite, stableUserId)).toBe(5_000_000)

	const secondLogin = await reconcileSignupWelcomeCreditsIfPending({
		db,
		userId: stableUserId,
		now,
	})
	expect(secondLogin).toBeNull()
	expect(ledgerCount(sqlite, stableUserId)).toBe(1)
	expect(walletBalance(sqlite, stableUserId)).toBe(5_000_000)

	const alreadyGranted = await grantSignupWelcomeCredits({
		db,
		userId: stableUserId,
		now,
	})
	expect(alreadyGranted.applied).toBe(false)
	expect(ledgerCount(sqlite, stableUserId)).toBe(1)
	expect(walletBalance(sqlite, stableUserId)).toBe(5_000_000)
})

test('reconcile does not grant when pending is unset (no pre-ship backfill)', async () => {
	const { sqlite, db } = createDb()
	const stableUserId = 'stable-welcome-grandfather'
	seedUser(sqlite, {
		stableUserId,
		email: 'welcome-grandfather@example.com',
		username: 'welcome-grandfather',
		pending: false,
	})

	expect(
		await reconcileSignupWelcomeCreditsIfPending({
			db,
			userId: stableUserId,
			now,
		}),
	).toBeNull()
	expect(ledgerCount(sqlite, stableUserId)).toBe(0)
	expect(walletBalance(sqlite, stableUserId)).toBe(0)
	expect(pendingFlag(sqlite, stableUserId)).toBe(0)
})

test('reconcile of a pending account that already has signup_welcome clears pending without a second $5', async () => {
	const { sqlite, db } = createDb()
	const stableUserId = 'stable-welcome-already'
	seedUser(sqlite, {
		stableUserId,
		email: 'welcome-already@example.com',
		username: 'welcome-already',
		pending: true,
	})
	const first = await grantSignupWelcomeCredits({
		db,
		userId: stableUserId,
		now,
	})
	expect(first.applied).toBe(true)
	sqlite
		.prepare(
			`UPDATE users SET signup_welcome_credits_pending = 1 WHERE stable_user_id = ?`,
		)
		.run(stableUserId)

	const reconciled = await reconcileSignupWelcomeCreditsIfPending({
		db,
		userId: stableUserId,
		now,
	})
	expect(reconciled).toEqual({
		applied: false,
		entryId: signupWelcomeCreditLedgerId(stableUserId),
		balanceMicroUsd: 5_000_000,
		createdAt: now.toISOString(),
	})
	expect(pendingFlag(sqlite, stableUserId)).toBe(0)
	expect(ledgerCount(sqlite, stableUserId)).toBe(1)
	expect(walletBalance(sqlite, stableUserId)).toBe(5_000_000)
})
