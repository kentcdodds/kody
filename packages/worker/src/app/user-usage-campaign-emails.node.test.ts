import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { type UsageCampaignSnapshot } from '#worker/usage/campaign-evaluator.ts'
import {
	claimUsageCampaignSend,
	listUsageCampaignSends,
	readUsageCampaign,
	upsertUsageCampaign,
} from '#worker/usage/campaign-ledger.ts'
import { type UsageCampaignCandidate } from '#worker/usage/campaign-inputs.ts'
import { usageCampaignFirstSendDwellMs } from '#worker/usage/campaign-states.ts'

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

const {
	openVerifiedNoMcpCampaignEvent,
	recordVerifiedNoMcpCampaignSend,
	sendUserUsageCampaignEmails,
} = await import('#app/user-usage-campaign-emails.ts')

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
		COOKIE_SECRET: 'campaign-test-cookie-secret',
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
		html: string
		headers?: Record<string, string>
	}
	expect(payload.to).toBe('event@example.com')
	expect(payload.from).toBe('kody@kody.codes')
	expect(payload.subject).toBe('Connect the agent you already use')
	expect(payload.html).toContain('Unsubscribe from tips')
	expect(payload.headers?.['List-Unsubscribe']).toMatch(
		/^<https:\/\/kody\.codes\/unsubscribe\/tips\?token=/,
	)
	expect(payload.headers?.['List-Unsubscribe-Post']).toBe(
		'List-Unsubscribe=One-Click',
	)
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

test('tips opt-out skips campaign mail and does not consume a send slot', async () => {
	const { db } = createDb()
	await insertUser(db, { id: 'user-opted', email: 'opted@example.com' })
	await db
		.prepare(
			`UPDATE users SET tips_emails_opted_out_at = ? WHERE stable_user_id = ?`,
		)
		.bind('2026-09-06T00:00:00.000Z', 'user-opted')
		.run()
	const env = createEnv(db)
	await recordVerifiedNoMcpCampaignSend({
		env,
		userId: 'user-opted',
		now,
	})
	const later = new Date('2026-09-13T12:00:00.000Z')
	gatherUsageCampaignSnapshot.mockResolvedValue(snapshot({ now: later }))
	sendCloudflareEmail.mockClear()
	expect(await sendUserUsageCampaignEmails({ env, now: later })).toEqual({
		status: 'no_sends',
		evaluatedUsers: 1,
	})
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect(await listUsageCampaignSends(db, 'user-opted')).toEqual([
		expect.objectContaining({
			state: 'VerifiedNoMcp',
			send_index: 1,
		}),
	])
})

test('a lost send-ledger race does not persist a stale campaign row', async () => {
	const { db } = createDb()
	await insertUser(db, {
		id: 'user-race',
		email: 'race@example.com',
		packageAt: '2026-07-01T00:00:00.000Z',
	})
	const env = createEnv(db)
	const enteredAt = '2026-09-06T11:00:00.000Z'
	await upsertUsageCampaign({
		db,
		userId: 'user-race',
		state: 'Cooling',
		enteredAt,
		sendCount: 0,
		lastSentAt: null,
		origin: 'event',
		coolingTerminal: false,
		everActivated: false,
		now: new Date(enteredAt),
	})
	const claimed = await claimUsageCampaignSend({
		db,
		userId: 'user-race',
		state: 'Cooling',
		template: 'cooling',
		sendIndex: 1,
		now: new Date(enteredAt),
	})
	expect(claimed).toBe(true)
	const before = await readUsageCampaign(db, 'user-race')
	gatherUsageCampaignSnapshot.mockResolvedValue(
		snapshot({
			firstSavedPackageAt: '2026-07-01T00:00:00.000Z',
			lastActiveAt: '2026-07-01T00:00:00.000Z',
			now,
		}),
	)
	sendCloudflareEmail.mockClear()
	expect(await sendUserUsageCampaignEmails({ env, now })).toEqual({
		status: 'no_sends',
		evaluatedUsers: 1,
	})
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	const after = await readUsageCampaign(db, 'user-race')
	expect(after?.send_count).toBe(0)
	expect(after?.last_sent_at).toBeNull()
	expect(after?.last_evaluated_at).toBe(before?.last_evaluated_at)
	expect(after?.cooling_terminal).toBe(0)
})

test('a later seed persist cannot clobber a verify-time event row', async () => {
	const { db } = createDb()
	await insertUser(db, { id: 'user-verify', email: 'verify@example.com' })
	const env = createEnv(db)
	expect(
		await recordVerifiedNoMcpCampaignSend({
			env,
			userId: 'user-verify',
			now,
		}),
	).toBe(true)
	const verifyRow = await readUsageCampaign(db, 'user-verify')
	expect(verifyRow).toMatchObject({
		state: 'VerifiedNoMcp',
		send_count: 1,
		origin: 'event',
		last_sent_at: now.toISOString(),
	})

	const sweepAt = new Date('2026-09-07T12:00:05.000Z')
	await upsertUsageCampaign({
		db,
		userId: 'user-verify',
		state: 'VerifiedNoMcp',
		enteredAt: sweepAt.toISOString(),
		sendCount: 0,
		lastSentAt: null,
		origin: 'seed',
		coolingTerminal: false,
		everActivated: false,
		now: sweepAt,
	})
	const afterSweep = await readUsageCampaign(db, 'user-verify')
	expect(afterSweep).toMatchObject({
		state: 'VerifiedNoMcp',
		send_count: 1,
		origin: 'event',
		last_sent_at: now.toISOString(),
		last_evaluated_at: sweepAt.toISOString(),
	})
})

test('campaign upsert never clears cooling_terminal or ever_activated', async () => {
	const { db } = createDb()
	await insertUser(db, { id: 'user-sticky', email: 'sticky@example.com' })
	await upsertUsageCampaign({
		db,
		userId: 'user-sticky',
		state: 'Cooling',
		enteredAt: now.toISOString(),
		sendCount: 1,
		lastSentAt: now.toISOString(),
		origin: 'event',
		coolingTerminal: true,
		everActivated: true,
		now,
	})
	const later = new Date('2026-09-07T12:00:05.000Z')
	await upsertUsageCampaign({
		db,
		userId: 'user-sticky',
		state: 'Activated',
		enteredAt: later.toISOString(),
		sendCount: 0,
		lastSentAt: null,
		origin: 'event',
		coolingTerminal: false,
		everActivated: false,
		now: later,
	})
	expect(await readUsageCampaign(db, 'user-sticky')).toMatchObject({
		state: 'Activated',
		cooling_terminal: 1,
		ever_activated: 1,
	})
})

test('failed unsubscribe mint releases the claim and does not send campaign mail', async () => {
	const { db } = createDb()
	await insertUser(db, { id: 'user-mint', email: 'mint@example.com' })
	const env = createEnv(db)
	env.COOKIE_SECRET = ''
	await upsertUsageCampaign({
		db,
		userId: 'user-mint',
		state: 'VerifiedNoMcp',
		enteredAt: '2026-09-01T00:00:00.000Z',
		sendCount: 1,
		lastSentAt: now.toISOString(),
		origin: 'event',
		coolingTerminal: false,
		everActivated: false,
		now,
	})
	await claimUsageCampaignSend({
		db,
		userId: 'user-mint',
		state: 'VerifiedNoMcp',
		template: 'verified_no_mcp',
		sendIndex: 1,
		now,
	})
	const later = new Date('2026-09-13T12:00:00.000Z')
	gatherUsageCampaignSnapshot.mockResolvedValue(snapshot({ now: later }))
	sendCloudflareEmail.mockClear()
	consoleWarn.mockImplementation(() => {})
	expect(await sendUserUsageCampaignEmails({ env, now: later })).toEqual({
		status: 'no_sends',
		evaluatedUsers: 1,
	})
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect(await listUsageCampaignSends(db, 'user-mint')).toEqual([
		expect.objectContaining({
			state: 'VerifiedNoMcp',
			send_index: 1,
		}),
	])
	expect(consoleWarn).toHaveBeenCalledWith(
		'usage-campaign-unsubscribe-mint-failed',
		expect.any(Error),
	)
})

test('opening a verify-time event row lets the sweep send after a failed first mail', async () => {
	const { db } = createDb()
	await insertUser(db, { id: 'user-open', email: 'open@example.com' })
	const env = createEnv(db)
	expect(
		await openVerifiedNoMcpCampaignEvent({
			env,
			userId: 'user-open',
			now,
		}),
	).toBe(true)
	expect(await readUsageCampaign(db, 'user-open')).toMatchObject({
		state: 'VerifiedNoMcp',
		origin: 'event',
		send_count: 0,
		last_sent_at: null,
	})
	expect(await listUsageCampaignSends(db, 'user-open')).toEqual([])

	const later = new Date(now.getTime() + usageCampaignFirstSendDwellMs)
	gatherUsageCampaignSnapshot.mockResolvedValue(snapshot({ now: later }))
	sendCloudflareEmail.mockClear()
	expect(await sendUserUsageCampaignEmails({ env, now: later })).toEqual({
		status: 'notified',
		evaluatedUsers: 1,
		emailedUsers: 1,
		emailsSent: 1,
	})
	expect((await readUsageCampaign(db, 'user-open'))?.send_count).toBe(1)
	expect((await listUsageCampaignSends(db, 'user-open')).length).toBe(1)
})

test('advocate one-shot uses the live referral share URL and never repeats', async () => {
	const { db } = createDb()
	await insertUser(db, {
		id: 'kentcdodds',
		email: 'advocate@example.com',
		stripePlan: 'pro',
	})
	const env = createEnv(db)
	gatherUsageCampaignSnapshot.mockImplementation(
		async (input: { user: UsageCampaignCandidate }) =>
			snapshot({
				isStripePaid: true,
				username: input.user.username,
			}),
	)
	expect(await sendUserUsageCampaignEmails({ env, now })).toEqual({
		status: 'no_sends',
		evaluatedUsers: 1,
	})
	expect((await readUsageCampaign(db, 'kentcdodds'))?.state).toBe('Paid')
	expect(
		(await readUsageCampaign(db, 'kentcdodds'))?.advocate_sent_at,
	).toBeNull()

	const due = new Date('2026-09-14T12:00:00.000Z')
	gatherUsageCampaignSnapshot.mockImplementation(
		async (input: { user: UsageCampaignCandidate }) =>
			snapshot({
				isStripePaid: true,
				username: input.user.username,
				now: due,
			}),
	)
	sendCloudflareEmail.mockClear()
	expect(await sendUserUsageCampaignEmails({ env, now: due })).toEqual({
		status: 'notified',
		evaluatedUsers: 1,
		emailedUsers: 1,
		emailsSent: 1,
	})
	const payload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		to: string
		subject: string
		html: string
		text: string
	}
	expect(payload.to).toBe('advocate@example.com')
	expect(payload.subject).toBe('Share Kody (and a free month)')
	expect(payload.html).toContain('https://kody.codes/signup?ref=kentcdodds')
	expect(payload.text).toContain(
		'mailto:me@kentcdodds.com?subject=Kody%20testimonial',
	)
	expect(await listUsageCampaignSends(db, 'kentcdodds')).toEqual([
		expect.objectContaining({
			state: 'Paid',
			template: 'advocate_referral_testimonial',
			send_index: 1,
		}),
	])
	const afterSend = await readUsageCampaign(db, 'kentcdodds')
	expect(afterSend?.send_count).toBe(0)
	expect(afterSend?.advocate_sent_at).toBe(due.toISOString())
	expect(afterSend?.last_sent_at).toBeNull()

	sendCloudflareEmail.mockClear()
	expect(await sendUserUsageCampaignEmails({ env, now: due })).toEqual({
		status: 'no_sends',
		evaluatedUsers: 1,
	})
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect((await listUsageCampaignSends(db, 'kentcdodds')).length).toBe(1)
})
