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
	listUsersForUsageCampaignSweep,
	openVerifiedNoMcpCampaignEvent,
	recordVerifiedNoMcpCampaignSend,
	sendUserUsageCampaignEmails,
} = await import('#app/user-usage-campaign-emails.ts')

const now = new Date('2026-09-07T12:00:00.000Z')
const later = new Date('2026-09-13T12:00:00.000Z')
const due = new Date('2026-09-14T12:00:00.000Z')

type TestUserInput = {
	id: string
	email: string
	verified?: boolean
	mcpAt?: string | null
	packageAt?: string | null
	clientName?: string | null
	stripePlan?: string | null
}

async function setup(...users: Array<TestUserInput>) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	for (const input of users) {
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
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'https://kody.codes/',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		COOKIE_SECRET: 'campaign-test-cookie-secret',
	} as unknown as Env
	return { db, env }
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

function mockSnapshots(
	at: Date,
	byUser: Record<string, Partial<UsageCampaignSnapshot>> = {},
) {
	gatherUsageCampaignSnapshot.mockImplementation(
		async (input: { user: UsageCampaignCandidate }) =>
			snapshot({ now: at, ...byUser[input.user.stable_user_id] }),
	)
}

function upsert(
	db: D1Database,
	userId: string,
	overrides: Partial<Parameters<typeof upsertUsageCampaign>[0]> = {},
) {
	return upsertUsageCampaign({
		db,
		userId,
		state: 'VerifiedNoMcp',
		enteredAt: now.toISOString(),
		sendCount: 0,
		lastSentAt: null,
		origin: 'event',
		coolingTerminal: false,
		everActivated: false,
		now,
		...overrides,
	})
}

function claimVerifiedNoMcp(db: D1Database, userId: string, at = now) {
	return claimUsageCampaignSend({
		db,
		userId,
		state: 'VerifiedNoMcp',
		template: 'verified_no_mcp',
		sendIndex: 1,
		now: at,
	})
}

async function sweep(env: Env, at: Date) {
	sendCloudflareEmail.mockClear()
	return await sendUserUsageCampaignEmails({ env, now: at })
}

const noSends = (evaluatedUsers = 1) => ({ status: 'no_sends', evaluatedUsers })
const notified = (evaluatedUsers = 1) => ({
	status: 'notified',
	evaluatedUsers,
	emailedUsers: 1,
	emailsSent: 1,
})
const onlyVerifiedNoMcpSend = [
	expect.objectContaining({ state: 'VerifiedNoMcp', send_index: 1 }),
]

test('campaign sweep seeds without mailing, then event-origin sends are ledger-idempotent and Activated stays silent', async () => {
	const { db, env } = await setup(
		{ id: 'user-seed', email: 'seed@example.com' },
		{ id: 'user-event', email: 'event@example.com' },
		{ id: 'user-paid', email: 'paid@example.com', stripePlan: 'pro' },
	)
	const paid = { 'user-paid': { isStripePaid: true } }

	mockSnapshots(now, paid)
	expect(await sweep(env, now)).toEqual(noSends(3))
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect((await readUsageCampaign(db, 'user-seed'))?.origin).toBe('seed')
	expect((await readUsageCampaign(db, 'user-paid'))?.state).toBe('Paid')

	const recordEvent = () =>
		recordVerifiedNoMcpCampaignSend({ env, userId: 'user-event', now })
	expect(await recordEvent()).toBe(true)
	expect(await recordEvent()).toBe(false)
	expect(await listUsageCampaignSends(db, 'user-event')).toEqual([
		expect.objectContaining({
			state: 'VerifiedNoMcp',
			template: 'verified_no_mcp',
			send_index: 1,
		}),
	])

	mockSnapshots(later, paid)
	expect(await sweep(env, later)).toEqual(notified(3))
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
	expect(await listUsageCampaignSends(db, 'user-event')).toHaveLength(2)
	expect((await readUsageCampaign(db, 'user-event'))?.send_count).toBe(2)

	expect(await sweep(env, later)).toEqual(noSends(3))
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	mockSnapshots(later, {
		...paid,
		'user-event': {
			firstSavedPackageAt: '2026-09-10T00:00:00.000Z',
			distinctInboundClientCount: 2,
			lastActiveAt: later.toISOString(),
			hasStrongRecentUse: true,
		},
	})
	expect(await sweep(env, later)).toEqual(noSends(3))
	expect((await readUsageCampaign(db, 'user-event'))?.state).toBe('Activated')
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
})

test('failed campaign sends release the ledger claim so a later sweep can retry', async () => {
	const { db, env } = await setup({
		id: 'user-retry',
		email: 'retry@example.com',
		clientName: 'Cursor',
	})
	await recordVerifiedNoMcpCampaignSend({ env, userId: 'user-retry', now })
	const connected = { firstMcpConnectedAt: '2026-09-08T00:00:00.000Z' }
	gatherUsageCampaignSnapshot.mockResolvedValue(
		snapshot({ ...connected, now: later }),
	)
	await sweep(env, later)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect((await readUsageCampaign(db, 'user-retry'))?.state).toBe(
		'ConnectedNoPackage',
	)

	gatherUsageCampaignSnapshot.mockResolvedValue(
		snapshot({ ...connected, now: due }),
	)
	sendCloudflareEmail.mockResolvedValueOnce({
		ok: false,
		error: 'unconfigured',
	})
	consoleWarn.mockImplementation(() => {})
	expect(await sendUserUsageCampaignEmails({ env, now: due })).toEqual(
		noSends(),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'usage-campaign-send-skipped',
		expect.objectContaining({ reason: 'unconfigured' }),
	)
	expect(await listUsageCampaignSends(db, 'user-retry')).toEqual(
		onlyVerifiedNoMcpSend,
	)

	sendCloudflareEmail.mockResolvedValueOnce({ ok: true })
	expect(await sendUserUsageCampaignEmails({ env, now: due })).toEqual(
		notified(),
	)
	const keep = sendCloudflareEmail.mock.calls.at(-1)?.[1] as { subject: string }
	expect(keep.subject).toBe('Keep what Cursor just figured out')
	expect(await listUsageCampaignSends(db, 'user-retry')).toEqual([
		...onlyVerifiedNoMcpSend,
		expect.objectContaining({
			state: 'ConnectedNoPackage',
			template: 'connected_no_package',
			send_index: 1,
		}),
	])
})

test('tips opt-out skips campaign mail and does not consume a send slot', async () => {
	const { db, env } = await setup({
		id: 'user-opted',
		email: 'opted@example.com',
	})
	await db
		.prepare(
			`INSERT INTO user_tips_email_opt_outs (user_id, opted_out_at) VALUES (?, ?)`,
		)
		.bind('user-opted', '2026-09-06T00:00:00.000Z')
		.run()
	await recordVerifiedNoMcpCampaignSend({ env, userId: 'user-opted', now })
	gatherUsageCampaignSnapshot.mockResolvedValue(snapshot({ now: later }))
	expect(await sweep(env, later)).toEqual(noSends())
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect(await listUsageCampaignSends(db, 'user-opted')).toEqual(
		onlyVerifiedNoMcpSend,
	)
})

test('a lost send-ledger race does not persist a stale campaign row', async () => {
	const { db, env } = await setup({
		id: 'user-race',
		email: 'race@example.com',
		packageAt: '2026-07-01T00:00:00.000Z',
	})
	const enteredAt = new Date('2026-09-06T11:00:00.000Z')
	await upsert(db, 'user-race', {
		state: 'Cooling',
		enteredAt: enteredAt.toISOString(),
		now: enteredAt,
	})
	expect(
		await claimUsageCampaignSend({
			db,
			userId: 'user-race',
			state: 'Cooling',
			template: 'cooling',
			sendIndex: 1,
			now: enteredAt,
		}),
	).toBe(true)
	const before = await readUsageCampaign(db, 'user-race')
	gatherUsageCampaignSnapshot.mockResolvedValue(
		snapshot({
			firstSavedPackageAt: '2026-07-01T00:00:00.000Z',
			lastActiveAt: '2026-07-01T00:00:00.000Z',
		}),
	)
	expect(await sweep(env, now)).toEqual(noSends())
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	const after = await readUsageCampaign(db, 'user-race')
	expect(after?.send_count).toBe(0)
	expect(after?.last_sent_at).toBeNull()
	expect(after?.last_evaluated_at).toBe(now.toISOString())
	expect(after?.last_evaluated_at).not.toBe(before?.last_evaluated_at)
	expect(after?.cooling_terminal).toBe(0)
})

test('re-entry claim loss persists last_evaluated_at without mailing again', async () => {
	const { db, env } = await setup({
		id: 'user-reentry',
		email: 'reentry@example.com',
	})
	const enteredAt = new Date('2026-08-20T00:00:00.000Z')
	await upsert(db, 'user-reentry', {
		state: 'LimitAware',
		enteredAt: enteredAt.toISOString(),
		now: enteredAt,
	})
	expect(
		await claimVerifiedNoMcp(
			db,
			'user-reentry',
			new Date('2026-08-01T00:00:00.000Z'),
		),
	).toBe(true)
	const dwellElapsed = new Date(now.getTime() + usageCampaignFirstSendDwellMs)
	gatherUsageCampaignSnapshot.mockResolvedValue(snapshot({ now: dwellElapsed }))
	expect(await sweep(env, dwellElapsed)).toEqual(noSends())
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect(await readUsageCampaign(db, 'user-reentry')).toMatchObject({
		state: 'VerifiedNoMcp',
		send_count: 0,
		last_sent_at: null,
		last_evaluated_at: dwellElapsed.toISOString(),
		origin: 'event',
	})
	expect(await listUsageCampaignSends(db, 'user-reentry')).toEqual(
		onlyVerifiedNoMcpSend,
	)
})

test('campaign upsert keeps verify-time event rows over later seeds and never clears sticky flags', async () => {
	const { db, env } = await setup(
		{ id: 'user-verify', email: 'verify@example.com' },
		{ id: 'user-sticky', email: 'sticky@example.com' },
	)
	expect(
		await recordVerifiedNoMcpCampaignSend({ env, userId: 'user-verify', now }),
	).toBe(true)
	const eventRow = {
		state: 'VerifiedNoMcp',
		send_count: 1,
		origin: 'event',
		last_sent_at: now.toISOString(),
	}
	expect(await readUsageCampaign(db, 'user-verify')).toMatchObject(eventRow)

	const sweepAt = new Date('2026-09-07T12:00:05.000Z')
	await upsert(db, 'user-verify', {
		enteredAt: sweepAt.toISOString(),
		origin: 'seed',
		now: sweepAt,
	})
	expect(await readUsageCampaign(db, 'user-verify')).toMatchObject({
		...eventRow,
		last_evaluated_at: sweepAt.toISOString(),
	})

	await upsert(db, 'user-sticky', {
		state: 'Cooling',
		sendCount: 1,
		lastSentAt: now.toISOString(),
		coolingTerminal: true,
		everActivated: true,
	})
	await upsert(db, 'user-sticky', {
		state: 'Activated',
		enteredAt: sweepAt.toISOString(),
		now: sweepAt,
	})
	expect(await readUsageCampaign(db, 'user-sticky')).toMatchObject({
		state: 'Activated',
		cooling_terminal: 1,
		ever_activated: 1,
	})
})

test('failed unsubscribe mint releases the claim and does not send campaign mail', async () => {
	const { db, env } = await setup({
		id: 'user-mint',
		email: 'mint@example.com',
	})
	env.COOKIE_SECRET = ''
	await upsert(db, 'user-mint', {
		enteredAt: '2026-09-01T00:00:00.000Z',
		sendCount: 1,
		lastSentAt: now.toISOString(),
	})
	await claimVerifiedNoMcp(db, 'user-mint')
	gatherUsageCampaignSnapshot.mockResolvedValue(snapshot({ now: later }))
	consoleWarn.mockImplementation(() => {})
	expect(await sweep(env, later)).toEqual(noSends())
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect(await listUsageCampaignSends(db, 'user-mint')).toEqual(
		onlyVerifiedNoMcpSend,
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'usage-campaign-unsubscribe-mint-failed',
		expect.any(Error),
	)
})

test('opening a verify-time event row lets the sweep send after a failed first mail', async () => {
	const { db, env } = await setup({
		id: 'user-open',
		email: 'open@example.com',
	})
	expect(
		await openVerifiedNoMcpCampaignEvent({ env, userId: 'user-open', now }),
	).toBe(true)
	expect(await readUsageCampaign(db, 'user-open')).toMatchObject({
		state: 'VerifiedNoMcp',
		origin: 'event',
		send_count: 0,
		last_sent_at: null,
	})
	expect(await listUsageCampaignSends(db, 'user-open')).toEqual([])

	const dwellElapsed = new Date(now.getTime() + usageCampaignFirstSendDwellMs)
	gatherUsageCampaignSnapshot.mockResolvedValue(snapshot({ now: dwellElapsed }))
	expect(await sweep(env, dwellElapsed)).toEqual(notified())
	expect((await readUsageCampaign(db, 'user-open'))?.send_count).toBe(1)
	expect(await listUsageCampaignSends(db, 'user-open')).toHaveLength(1)
})

test('advocate one-shot uses the live referral share URL and never repeats', async () => {
	const { db, env } = await setup({
		id: 'kentcdodds',
		email: 'advocate@example.com',
		stripePlan: 'pro',
	})
	const mockPaidAdvocate = (at: Date) =>
		gatherUsageCampaignSnapshot.mockImplementation(
			async (input: { user: UsageCampaignCandidate }) =>
				snapshot({
					isStripePaid: true,
					username: input.user.username,
					now: at,
				}),
		)
	mockPaidAdvocate(now)
	expect(await sweep(env, now)).toEqual(noSends())
	expect(await readUsageCampaign(db, 'kentcdodds')).toMatchObject({
		state: 'Paid',
		advocate_sent_at: null,
	})

	mockPaidAdvocate(due)
	expect(await sweep(env, due)).toEqual(notified())
	const payload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		to: string
		subject: string
		html: string
		text: string
	}
	expect(payload.to).toBe('advocate@example.com')
	expect(payload.subject).toBe('Share Kody (and get a month free)')
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
	expect(await readUsageCampaign(db, 'kentcdodds')).toMatchObject({
		send_count: 0,
		advocate_sent_at: due.toISOString(),
		last_sent_at: null,
	})

	expect(await sweep(env, due)).toEqual(noSends())
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
	expect(await listUsageCampaignSends(db, 'kentcdodds')).toHaveLength(1)
})

test('campaign sweep selects referral overlay expiry for stock-cap plan reads', async () => {
	const { db } = await setup({
		id: 'user-overlay',
		email: 'overlay@example.com',
	})
	await db
		.prepare(
			`UPDATE users
			 SET referral_standard_credit_expires_at = ?,
			     second_agent_standard_gift_expires_at = ?
			 WHERE stable_user_id = ?`,
		)
		.bind(
			'2026-10-01T00:00:00.000Z',
			'2026-09-20T00:00:00.000Z',
			'user-overlay',
		)
		.run()
	expect(await listUsersForUsageCampaignSweep(db, 10)).toEqual([
		expect.objectContaining({
			stable_user_id: 'user-overlay',
			referral_standard_credit_expires_at: '2026-10-01T00:00:00.000Z',
			second_agent_standard_gift_expires_at: '2026-09-20T00:00:00.000Z',
		}),
	])
})
