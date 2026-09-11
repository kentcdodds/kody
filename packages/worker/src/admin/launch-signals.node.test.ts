import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { platformPublicOpenedDay } from '#universal/platform-open.ts'
import { loadAdminLaunchSignals } from './launch-signals.ts'

const now = new Date('2026-09-10T18:00:00.000Z')

function createLaunchSignalsDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function insertUser(
	sqlite: DatabaseSync,
	row: {
		username: string
		stableUserId: string
		plan?: string
		stripePlan?: string | null
		stripePriceId?: string | null
		entitlementLadder?: string
		emailVerifiedAt?: string | null
		firstMcpConnectedAt?: string | null
		firstSearchAt?: string | null
		firstExecuteAt?: string | null
		firstSavedPackageAt?: string | null
		mcpClientName?: string | null
		lastActiveAt?: string | null
		giftExpiresAt?: string | null
		referralExpiresAt?: string | null
		createdAt?: string
		deletingAt?: string | null
	},
) {
	sqlite
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, plan, stripe_plan,
				stripe_price_id, entitlement_ladder, email_verified_at,
				first_mcp_connected_at, first_search_at, first_execute_at,
				first_saved_package_at, mcp_client_name, last_active_at,
				second_agent_standard_gift_expires_at, referral_standard_credit_expires_at,
				created_at, updated_at, deleting_at, account_type
			) VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'person')`,
		)
		.run(
			row.username,
			`${row.username}@example.com`,
			row.stableUserId,
			row.plan ?? 'free',
			row.stripePlan ?? null,
			row.stripePriceId ?? null,
			row.entitlementLadder ?? 'public',
			row.emailVerifiedAt ?? null,
			row.firstMcpConnectedAt ?? null,
			row.firstSearchAt ?? null,
			row.firstExecuteAt ?? null,
			row.firstSavedPackageAt ?? null,
			row.mcpClientName ?? null,
			row.lastActiveAt ?? null,
			row.giftExpiresAt ?? null,
			row.referralExpiresAt ?? null,
			row.createdAt ?? '2026-08-01T00:00:00.000Z',
			row.createdAt ?? '2026-08-01T00:00:00.000Z',
			row.deletingAt ?? null,
		)
}

test('launch signals aggregate paid MRR, funnels, activity, and overlays without paging users', async () => {
	const { sqlite, db } = createLaunchSignalsDb()
	insertUser(sqlite, {
		username: 'paid-monthly',
		stableUserId: 'user-paid-monthly',
		plan: 'free',
		stripePlan: 'standard',
		stripePriceId: 'price_standard',
		emailVerifiedAt: '2026-08-02T00:00:00.000Z',
		firstMcpConnectedAt: '2026-08-03T00:00:00.000Z',
		firstSearchAt: '2026-08-03T01:00:00.000Z',
		firstExecuteAt: '2026-08-03T02:00:00.000Z',
		firstSavedPackageAt: '2026-08-04T00:00:00.000Z',
		mcpClientName: 'Cursor',
		lastActiveAt: '2026-09-10T16:00:00.000Z',
		entitlementLadder: 'legacy',
	})
	insertUser(sqlite, {
		username: 'paid-yearly',
		stableUserId: 'user-paid-yearly',
		plan: 'pro',
		stripePlan: 'pro',
		stripePriceId: 'price_pro_yearly',
		emailVerifiedAt: '2026-09-10T08:00:00.000Z',
		firstMcpConnectedAt: '2026-09-10T09:00:00.000Z',
		mcpClientName: 'Claude Code',
		lastActiveAt: '2026-09-09T12:00:00.000Z',
		createdAt: '2026-09-10T07:00:00.000Z',
	})
	insertUser(sqlite, {
		username: 'gifted',
		stableUserId: 'user-gifted',
		plan: 'free',
		giftExpiresAt: '2026-09-20T00:00:00.000Z',
		emailVerifiedAt: '2026-09-10T10:00:00.000Z',
		lastActiveAt: '2026-09-03T00:00:00.000Z',
		createdAt: '2026-09-10T10:00:00.000Z',
	})
	insertUser(sqlite, {
		username: 'deleting',
		stableUserId: 'user-deleting',
		stripePlan: 'pro',
		stripePriceId: 'price_pro',
		deletingAt: '2026-09-10T00:00:00.000Z',
	})
	sqlite
		.prepare(
			`INSERT INTO platform_feedback (
				id, submitter_user_id, submitter_username, submitter_email,
				category, summary, details, status, created_at, updated_at
			) VALUES
				('fb-open', 'user-gifted', 'gifted', 'gifted@example.com',
					'bug', 'Open bug', 'details', 'open', ?, ?),
				('fb-done', 'user-gifted', 'gifted', 'gifted@example.com',
					'suggestion', 'Done idea', 'details', 'resolved', ?, ?)`,
		)
		.run(
			now.toISOString(),
			now.toISOString(),
			now.toISOString(),
			now.toISOString(),
		)

	const signals = await loadAdminLaunchSignals({
		db,
		env: {
			STRIPE_STANDARD_PRICE_ID: 'price_standard',
			STRIPE_STANDARD_YEARLY_PRICE_ID: 'price_standard_yearly',
			STRIPE_PRO_PRICE_ID: 'price_pro',
			STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
		},
		now,
	})

	expect(signals.openedDay).toBe(platformPublicOpenedDay)
	expect(signals.paidSubscribers).toBe(2)
	expect(signals.mrrUsdCents).toBe(1_200 + 4_000)
	expect(signals.paidSlices).toEqual([
		{
			plan: 'pro',
			interval: 'year',
			subscribers: 1,
			mrrUsdCents: 4_000,
		},
		{
			plan: 'standard',
			interval: 'month',
			subscribers: 1,
			mrrUsdCents: 1_200,
		},
	])
	expect(signals.manualPlans).toEqual([
		{ plan: 'free', count: 2 },
		{ plan: 'pro', count: 1 },
	])
	expect(signals.stripePlans).toEqual([
		{ plan: 'none', count: 1 },
		{ plan: 'pro', count: 1 },
		{ plan: 'standard', count: 1 },
	])
	expect(signals.effectivePlans).toEqual([
		{ plan: 'standard', count: 2 },
		{ plan: 'pro', count: 1 },
	])
	expect(signals.overlayStandard).toBe(1)
	expect(signals.entitlementLadders).toEqual({ public: 2, legacy: 1 })
	expect(signals.paidEntitlementLadders).toEqual({ public: 1, legacy: 1 })
	expect(signals.activeUsers).toEqual({
		hours24: 2,
		hours48: 2,
		days7: 3,
	})
	expect(signals.activation.overall).toEqual([
		{ step: 'signed_up', users: 3 },
		{ step: 'email_verified', users: 3 },
		{ step: 'first_mcp', users: 2 },
		{ step: 'first_search', users: 1 },
		{ step: 'first_execute', users: 1 },
		{ step: 'first_saved_package', users: 1 },
	])
	expect(signals.activation.sinceOpen).toEqual([
		{ step: 'signed_up', users: 2 },
		{ step: 'email_verified', users: 2 },
		{ step: 'first_mcp', users: 1 },
		{ step: 'first_search', users: 0 },
		{ step: 'first_execute', users: 0 },
		{ step: 'first_saved_package', users: 0 },
	])
	expect(signals.mcpClients).toEqual([
		{ kind: 'claude-code', label: 'Claude Code', count: 1 },
		{ kind: 'cursor', label: 'Cursor', count: 1 },
	])
	expect(signals.openPlatformFeedback).toBe(1)
})

test('active windows count last_active_at UTC days, not a rolling ISO-hour cutoff', async () => {
	const { sqlite, db } = createLaunchSignalsDb()
	insertUser(sqlite, {
		username: 'yesterday-early',
		stableUserId: 'user-yesterday-early',
		lastActiveAt: '2026-09-10T01:00:00.000Z',
		createdAt: '2026-09-01T00:00:00.000Z',
	})

	const signals = await loadAdminLaunchSignals({
		db,
		env: {
			STRIPE_STANDARD_PRICE_ID: 'price_standard',
			STRIPE_STANDARD_YEARLY_PRICE_ID: 'price_standard_yearly',
			STRIPE_PRO_PRICE_ID: 'price_pro',
			STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
		},
		now: new Date('2026-09-11T02:00:00.000Z'),
	})

	expect(signals.activeUsers).toEqual({
		hours24: 1,
		hours48: 1,
		days7: 1,
	})
})
