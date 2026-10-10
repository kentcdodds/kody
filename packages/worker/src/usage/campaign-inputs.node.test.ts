import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	gatherUsageCampaignSnapshot,
	isStripePaidPlan,
	isStrongRecentUse,
	type UsageCampaignCandidate,
} from './campaign-inputs.ts'
import {
	campaignClientLabel,
	isPackagedSingleClientTrialCtaLive,
} from './campaign-states.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const now = new Date('2026-09-07T12:00:00.000Z')
const noJobsEnv = { JOBS: { listJobsForUser: async () => [] } }

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function makeCandidate(
	overrides: Partial<UsageCampaignCandidate> = {},
): UsageCampaignCandidate {
	return {
		stable_user_id: ownerIdFromStored('user-stock'),
		username: 'stock',
		email: 'stock@example.com',
		email_verified_at: '2026-09-01T00:00:00.000Z',
		first_mcp_connected_at: null,
		first_saved_package_at: '2026-09-02T00:00:00.000Z',
		first_execute_at: null,
		mcp_client_name: null,
		last_active_at: null,
		second_agent_standard_gift_granted_at: null,
		second_agent_standard_gift_expires_at: null,
		referral_standard_credit_expires_at: null,
		plan: 'free',
		stripe_plan: null,
		entitlement_ladder: null,
		...overrides,
	}
}

test('campaign inputs treat Stripe Standard/Pro as paid and require execute depth for strong use', () => {
	expect(
		(['standard', 'pro', 'free', 'max', null] as const).map(isStripePaidPlan),
	).toEqual([true, true, false, false, false])

	const strongUseCases = [
		['2026-09-06', '2026-09-02', 3, true],
		['2026-09-06', '2026-09-02', 2, false],
		['2026-08-01', '2026-08-01', 20, false],
		['2026-09-06', null, 10, false],
	] as const
	expect(
		strongUseCases.map(([lastActive, firstExecute, executeCount]) =>
			isStrongRecentUse({
				lastActiveAt: `${lastActive}T00:00:00.000Z`,
				firstExecuteAt: firstExecute && `${firstExecute}T00:00:00.000Z`,
				executeCount,
				now,
			}),
		),
	).toEqual(strongUseCases.map(([, , , want]) => want))

	expect(campaignClientLabel(null)).toBe('your agent')
	expect(campaignClientLabel('Cursor')).toBe('Cursor')
	expect(isPackagedSingleClientTrialCtaLive({})).toBe(true)
	expect(
		isPackagedSingleClientTrialCtaLive({
			grantedAt: '2026-09-01T00:00:00.000Z',
			expiresAt: '2026-09-15T00:00:00.000Z',
			now,
		}),
	).toBe(false)
})

test('near-cap reads use Standard overlays, not the stored free plan', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, email_verified_at, stable_user_id
			) VALUES ('stock', 'stock@example.com', 'x', ?, 'user-stock')`,
		)
		.run('2026-09-01T00:00:00.000Z')
	// Free 80% of 10 packages is 8; Standard 80% of 50 is 40.
	for (let i = 0; i < 8; i += 1) {
		sqlite
			.prepare(
				`INSERT INTO saved_packages (
					id, user_id, name, kody_id, description, source_id
				) VALUES (?, 'user-stock', ?, ?, 'pkg', ?)`,
			)
			.run(`pkg-${i}`, `pkg-${i}`, `pkg-${i}`, `source-${i}`)
	}
	const env = { APP_DB: db, ...noJobsEnv } as unknown as Env

	const overlayCases: Array<[Partial<UsageCampaignCandidate>, boolean]> = [
		[{}, true],
		[
			{
				second_agent_standard_gift_granted_at: '2026-09-01T00:00:00.000Z',
				second_agent_standard_gift_expires_at: '2026-09-15T00:00:00.000Z',
			},
			false,
		],
		[
			{
				second_agent_standard_gift_granted_at: '2026-08-01T00:00:00.000Z',
				second_agent_standard_gift_expires_at: '2026-08-15T00:00:00.000Z',
			},
			true,
		],
		[
			{ referral_standard_credit_expires_at: '2026-10-01T00:00:00.000Z' },
			false,
		],
		[{ referral_standard_credit_expires_at: '2026-08-01T00:00:00.000Z' }, true],
	]
	const nearCap: Array<boolean> = []
	for (const [overrides] of overlayCases) {
		const snapshot = await gatherUsageCampaignSnapshot({
			env,
			user: makeCandidate(overrides),
			now,
		})
		nearCap.push(snapshot.isNearEntitlementCap)
	}
	expect(nearCap).toEqual(overlayCases.map(([, want]) => want))
})

test('execute rollup failures do not look like zero use', async () => {
	consoleWarn.mockImplementation(() => {})
	const { db } = createMigratedDb()
	const failingDb = {
		prepare(query: string) {
			if (query.includes('usage_rollups')) {
				throw new Error('rollup down')
			}
			return db.prepare(query)
		},
	}
	const snapshot = await gatherUsageCampaignSnapshot({
		env: { APP_DB: failingDb, ...noJobsEnv } as unknown as Env,
		user: makeCandidate({
			stable_user_id: ownerIdFromStored('user-exec'),
			username: 'exec',
			email: 'exec@example.com',
			first_mcp_connected_at: '2026-09-02T00:00:00.000Z',
			first_saved_package_at: '2026-09-03T00:00:00.000Z',
			first_execute_at: '2026-09-03T00:00:00.000Z',
			last_active_at: '2026-09-06T00:00:00.000Z',
		}),
		now,
	})
	expect(snapshot.executeReadFailed).toBe(true)
	expect(snapshot.hasStrongRecentUse).toBe(false)
	expect(consoleWarn).toHaveBeenCalledWith(
		'usage-campaign-execute-read-failed',
		expect.any(Error),
	)
})
