import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { type UsageCampaignSnapshot } from '#worker/usage/campaign-evaluator.ts'
import {
	listUsageCampaignSends,
	readUsageCampaign,
} from '#worker/usage/campaign-ledger.ts'
import { type UsageCampaignCandidate } from '#worker/usage/campaign-inputs.ts'

const sendCloudflareEmail = vi.fn(async () => ({ ok: true }))
const gatherUsageCampaignSnapshot = vi.fn()

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		sendCloudflareEmail(...args),
}))

vi.mock('#worker/usage/campaign-inputs.ts', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		gatherUsageCampaignSnapshot: (...args: Array<unknown>) =>
			gatherUsageCampaignSnapshot(...args),
	}
})

const { recordVerifiedNoMcpCampaignSend, sendUserUsageCampaignEmails } =
	await import('#app/user-usage-campaign-emails.ts')

const now = new Date('2026-09-07T12:00:00.000Z')

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function insertUser(
	db: D1Database,
	input: {
		id: string
		email: string
		verified?: boolean
		mcpAt?: string | null
		packageAt?: string | null
		clientName?: string | null
		stripePlan?: string | null
	},
) {
	await db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, email_verified_at, stable_user_id,
				plan, account_type, first_mcp_connected_at, first_saved_package_at,
				mcp_client_name, stripe_plan
			) VALUES (?, ?, 'x', ?, ?, 'free', 'person', ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.email,
			input.verified === false ? null : '2026-09-01T00:00:00.000Z',
			input.id,
			input.mcpAt ?? null,
			input.packageAt ?? null,
			input.clientName ?? null,
			input.stripePlan ?? null,
		)
		.run()
}

function createEnv(db: D1Database) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'https://kody.codes/',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
	} as unknown as Env
}

function snapshot(
	overrides: Partial<UsageCampaignSnapshot> = {},
): UsageCampaignSnapshot {
	return {
		emailVerifiedAt: '2026-09-01T00:00:00.000Z',
		firstMcpConnectedAt: null,
		firstSavedPackageAt: null,
		lastActiveAt: null,
		distinctInboundClientCount: 0,
		hasEnabledScheduledJob: false,
		lastJobActivityAt: null,
		hasStrongRecentUse: false,
		isStripePaid: false,
		isNearEntitlementCap: false,
		now,
		...overrides,
	}
}

test('campaign sweep seeds without mailing, then event-origin sends are ledger-idempotent and Activated stays silent', async () => {
	const { db } = createDb()
	await insertUser(db, { id: 'user-seed', email: 'seed@example.com' })
	await insertUser(db, { id: 'user-event', email: 'event@example.com' })
	await insertUser(db, {
		id: 'user-paid',
		email: 'paid@example.com',
		stripePlan: 'pro',
	})
	const env = createEnv(db)

	gatherUsageCampaignSnapshot.mockImplementation(
		async (input: { user: UsageCampaignCandidate }) => {
			if (input.user.stable_user_id === 'user-paid') {
				return snapshot({ isStripePaid: true })
			}
			return snapshot()
		},
	)

	expect(await sendUserUsageCampaignEmails({ env, now })).toEqual({
		status: 'no_sends',
		evaluatedUsers: 3,
	})
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect((await readUsageCampaign(db, 'user-seed'))?.origin).toBe('seed')
	expect((await readUsageCampaign(db, 'user-paid'))?.state).toBe('Paid')

	expect(
		await recordVerifiedNoMcpCampaignSend({
			env,
			userId: 'user-event',
			now,
		}),
	).toBe(true)
	expect(
		await recordVerifiedNoMcpCampaignSend({
			env,
			userId: 'user-event',
			now,
		}),
	).toBe(false)
	expect(await listUsageCampaignSends(db, 'user-event')).toEqual([
		expect.objectContaining({
			state: 'VerifiedNoMcp',
			template: 'verified_no_mcp',
			send_index: 1,
		}),
	])

	const later = new Date('2026-09-13T12:00:00.000Z')
	gatherUsageCampaignSnapshot.mockImplementation(
		async (input: { user: UsageCampaignCandidate }) => {
			if (input.user.stable_user_id === 'user-paid') {
				return snapshot({ isStripePaid: true, now: later })
			}
			if (input.user.stable_user_id === 'user-event') {
				return snapshot({ now: later })
			}
			return snapshot({ now: later })
		},
	)
	expect(await sendUserUsageCampaignEmails({ env, now: later })).toEqual({
		status: 'notified',
		evaluatedUsers: 3,
		emailedUsers: 1,
		emailsSent: 1,
	})
	const payload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		to: string
		from: string
		subject: string
	}
	expect(payload.to).toBe('event@example.com')
	expect(payload.from).toBe('kody@kody.codes')
	expect(payload.subject).toBe('Connect the agent you already use')
	expect((await listUsageCampaignSends(db, 'user-event')).length).toBe(2)
	expect((await readUsageCampaign(db, 'user-event'))?.send_count).toBe(2)

	sendCloudflareEmail.mockClear()
	expect(await sendUserUsageCampaignEmails({ env, now: later })).toEqual({
		status: 'no_sends',
		evaluatedUsers: 3,
	})
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	gatherUsageCampaignSnapshot.mockImplementation(
		async (input: { user: UsageCampaignCandidate }) => {
			if (input.user.stable_user_id === 'user-event') {
				return snapshot({
					firstSavedPackageAt: '2026-09-10T00:00:00.000Z',
					distinctInboundClientCount: 2,
					lastActiveAt: later.toISOString(),
					hasStrongRecentUse: true,
					now: later,
				})
			}
			if (input.user.stable_user_id === 'user-paid') {
				return snapshot({ isStripePaid: true, now: later })
			}
			return snapshot({ now: later })
		},
	)
	expect(await sendUserUsageCampaignEmails({ env, now: later })).toEqual({
		status: 'no_sends',
		evaluatedUsers: 3,
	})
	expect((await readUsageCampaign(db, 'user-event'))?.state).toBe('Activated')
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
})

test('failed campaign sends release the ledger claim so a later sweep can retry', async () => {
	const { db } = createDb()
	await insertUser(db, {
		id: 'user-retry',
		email: 'retry@example.com',
		clientName: 'Cursor',
	})
	const env = createEnv(db)
	await recordVerifiedNoMcpCampaignSend({
		env,
		userId: 'user-retry',
		now,
	})
	const later = new Date('2026-09-13T12:00:00.000Z')
	gatherUsageCampaignSnapshot.mockResolvedValue(
		snapshot({
			firstMcpConnectedAt: '2026-09-08T00:00:00.000Z',
			now: later,
		}),
	)
	await sendUserUsageCampaignEmails({ env, now: later })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect((await readUsageCampaign(db, 'user-retry'))?.state).toBe(
		'ConnectedNoPackage',
	)

	const due = new Date('2026-09-14T12:00:00.000Z')
	gatherUsageCampaignSnapshot.mockResolvedValue(
		snapshot({
			firstMcpConnectedAt: '2026-09-08T00:00:00.000Z',
			now: due,
		}),
	)
	sendCloudflareEmail.mockResolvedValueOnce({
		ok: false,
		error: 'unconfigured',
	})
	consoleWarn.mockImplementation(() => {})
	expect(await sendUserUsageCampaignEmails({ env, now: due })).toEqual({
		status: 'no_sends',
		evaluatedUsers: 1,
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'usage-campaign-send-skipped',
		expect.objectContaining({ reason: 'unconfigured' }),
	)
	expect(await listUsageCampaignSends(db, 'user-retry')).toEqual([
		expect.objectContaining({
			state: 'VerifiedNoMcp',
			send_index: 1,
		}),
	])

	sendCloudflareEmail.mockResolvedValueOnce({ ok: true })
	expect(await sendUserUsageCampaignEmails({ env, now: due })).toEqual({
		status: 'notified',
		evaluatedUsers: 1,
		emailedUsers: 1,
		emailsSent: 1,
	})
	const keep = sendCloudflareEmail.mock.calls.at(-1)?.[1] as { subject: string }
	expect(keep.subject).toBe('Keep what Cursor just figured out')
	expect(await listUsageCampaignSends(db, 'user-retry')).toEqual([
		expect.objectContaining({ state: 'VerifiedNoMcp', send_index: 1 }),
		expect.objectContaining({
			state: 'ConnectedNoPackage',
			template: 'connected_no_package',
			send_index: 1,
		}),
	])
})
