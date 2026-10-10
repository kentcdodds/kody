import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { loadAdminLaunchSignals } from './launch-signals.ts'

const now = new Date('2026-09-10T18:00:00.000Z')

function createLaunchSignalsDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

const stripeEnv = {
	STRIPE_PRO_PRICE_ID: 'price_pro',
	STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
}

function insertUser(
	sqlite: DatabaseSync,
	row: {
		username: string
		stable_user_id: string
		plan?: string
		stripe_plan?: string
		stripe_price_id?: string
		entitlement_ladder?: string
		email_verified_at?: string
		first_mcp_connected_at?: string
		first_search_at?: string
		first_execute_at?: string
		first_saved_package_at?: string
		mcp_client_name?: string
		last_active_at?: string
		second_agent_standard_gift_expires_at?: string
		created_at?: string
		deleting_at?: string
	},
) {
	const createdAt = row.created_at ?? '2026-08-01T00:00:00.000Z'
	const columns: Record<string, string> = {
		email: `${row.username}@example.com`,
		password_hash: 'x',
		plan: 'free',
		entitlement_ladder: 'public',
		account_type: 'person',
		...row,
		created_at: createdAt,
		updated_at: createdAt,
	}
	const orgColumnNames = new Set([
		'plan',
		'entitlement_ladder',
		'stripe_plan',
		'stripe_price_id',
		'second_agent_standard_gift_expires_at',
		'referral_standard_credit_expires_at',
	])
	const userColumns = Object.fromEntries(
		Object.entries(columns).filter(([name]) => !orgColumnNames.has(name)),
	)
	const userNames = Object.keys(userColumns)
	sqlite
		.prepare(
			`INSERT INTO users (${userNames.join(', ')}) VALUES (${userNames.map(() => '?').join(', ')})`,
		)
		.run(...Object.values(userColumns))
	const orgColumns: Record<string, string> = {
		id: row.stable_user_id,
		slug: row.username,
		plan: columns.plan ?? 'free',
		entitlement_ladder: columns.entitlement_ladder ?? 'public',
		created_at: createdAt,
		updated_at: createdAt,
	}
	for (const name of orgColumnNames) {
		const value = columns[name]
		if (
			value !== undefined &&
			name !== 'plan' &&
			name !== 'entitlement_ladder'
		) {
			orgColumns[name] = value
		}
	}
	const orgNames = Object.keys(orgColumns)
	sqlite
		.prepare(
			`INSERT INTO orgs (${orgNames.join(', ')}) VALUES (${orgNames.map(() => '?').join(', ')})`,
		)
		.run(...Object.values(orgColumns))
}

test('launch signals aggregate paid MRR, funnels, activity, and overlays without paging users', async () => {
	const { sqlite, db } = createLaunchSignalsDb()
	insertUser(sqlite, {
		username: 'paid-monthly',
		stable_user_id: 'user-paid-monthly',
		plan: 'free',
		stripe_plan: 'standard',
		stripe_price_id: 'price_1U3sg6LAQpAnsYszGeL2nc8O',
		email_verified_at: '2026-08-02T00:00:00.000Z',
		first_mcp_connected_at: '2026-08-03T00:00:00.000Z',
		first_search_at: '2026-08-03T01:00:00.000Z',
		first_execute_at: '2026-08-03T02:00:00.000Z',
		first_saved_package_at: '2026-08-04T00:00:00.000Z',
		mcp_client_name: 'Cursor',
		last_active_at: '2026-09-10T16:00:00.000Z',
		entitlement_ladder: 'legacy',
	})
	insertUser(sqlite, {
		username: 'paid-yearly',
		stable_user_id: 'user-paid-yearly',
		plan: 'pro',
		stripe_plan: 'pro',
		stripe_price_id: 'price_1UChg2LAQpAnsYszKAFCR778',
		email_verified_at: '2026-09-10T08:00:00.000Z',
		first_mcp_connected_at: '2026-09-10T09:00:00.000Z',
		mcp_client_name: 'Claude Code',
		last_active_at: '2026-09-09T12:00:00.000Z',
		created_at: '2026-09-10T07:00:00.000Z',
	})
	insertUser(sqlite, {
		username: 'gifted',
		stable_user_id: 'user-gifted',
		plan: 'free',
		second_agent_standard_gift_expires_at: '2026-09-20T00:00:00.000Z',
		email_verified_at: '2026-09-10T10:00:00.000Z',
		last_active_at: '2026-09-03T00:00:00.000Z',
		created_at: '2026-09-10T10:00:00.000Z',
	})
	insertUser(sqlite, {
		username: 'deleting',
		stable_user_id: 'user-deleting',
		stripe_plan: 'pro',
		stripe_price_id: 'price_pro',
		deleting_at: '2026-09-10T00:00:00.000Z',
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
		.run(...Array.from({ length: 4 }, () => now.toISOString()))

	const signals = await loadAdminLaunchSignals({
		db,
		env: stripeEnv,
		now,
	})

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
		{ plan: 'pro', count: 2 },
		{ plan: 'standard', count: 1 },
	])
	expect(signals.overlayPro).toBe(1)
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
		stable_user_id: 'user-yesterday-early',
		last_active_at: '2026-09-10T01:00:00.000Z',
		created_at: '2026-09-01T00:00:00.000Z',
	})

	const signals = await loadAdminLaunchSignals({
		db,
		env: stripeEnv,
		now: new Date('2026-09-11T02:00:00.000Z'),
	})

	expect(signals.activeUsers).toEqual({
		hours24: 1,
		hours48: 1,
		days7: 1,
	})
})
