import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import type * as PackageSubscriptionsModule from './package-subscriptions.ts'
import { handleInboundEmail } from './inbound.ts'
import { processInboundDeliveryEffects } from './inbound-effects.ts'
import { listEmailMessages } from './repo.ts'
import { upsertEmailSenderRule } from './sender-rules.ts'
import { systemEmailOwnerId } from './system-email.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const platformBaseUrl = 'https://kody.example.com'
const platformDomain = 'inbox.kody.example.com'
const systemDomain = 'kody.example.com'

const packageSubscriptionMocks = vi.hoisted(() => ({
	dispatchInboundEmailSubscriptionEvents: vi.fn(async () => []),
	dispatchSystemInboundEmailSubscriptionEvents: vi.fn(async () => []),
}))

vi.mock('./package-subscriptions.ts', async () => {
	const actual = await vi.importActual<typeof PackageSubscriptionsModule>(
		'./package-subscriptions.ts',
	)
	return {
		...actual,
		dispatchInboundEmailSubscriptionEvents:
			packageSubscriptionMocks.dispatchInboundEmailSubscriptionEvents,
		dispatchSystemInboundEmailSubscriptionEvents:
			packageSubscriptionMocks.dispatchSystemInboundEmailSubscriptionEvents,
	}
})

function createInboundEnv() {
	return { ...env, APP_BASE_URL: platformBaseUrl }
}

async function seedVerifiedAccount(input: {
	db: D1Database
	email: string
	username: string
}) {
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await input.db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(email) DO UPDATE SET
			   username = excluded.username,
			   email_verified_at = excluded.email_verified_at,
			   stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id),
			   plan = excluded.plan,
			   updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			input.username,
			input.email,
			'test-password-hash',
			new Date().toISOString(),
			stableUserId,
			'max',
		)
		.run()
	return stableUserId
}

async function readUserDailyReceiveCount(userId: string) {
	const result = await userMeterRpc({ env, userId }).read({
		resource: 'email_receives_per_day',
		day: new Date().toISOString().slice(0, 10),
	})
	return result.outcome === 'ready' ? result.count : 0
}

function dmarcFailAuthResults() {
	return 'mx.example.com; dmarc=fail (p=reject) header.from=example.net; spf=fail smtp.mailfrom=example.net; dkim=fail header.d=example.net'
}

function createWaitUntilContext() {
	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext
	return { ctx, waitUntilPromises }
}

test('user sender rules block before quota, quarantine/allow, and fall back to auth verdicts', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `spam-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `spam-${crypto.randomUUID()}@example.com`
	const userId = await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})
	const address = `${username}@${platformDomain}`

	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: 'blocked@spam.example',
		effect: 'block',
	})
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'domain',
		value: 'suspect.example',
		effect: 'quarantine',
	})
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: 'friend@example.net',
		effect: 'allow',
	})

	const blocked = createForwardableEmailMessage({
		from: 'blocked@spam.example',
		to: address,
		raw: [
			'From: Blocked <blocked@spam.example>',
			`To: ${address}`,
			'Subject: Blocked mail',
			'Message-ID: <blocked@spam.example>',
			'',
			'Should not land.',
		].join('\r\n'),
	})
	await handleInboundEmail(blocked, createInboundEnv())
	expect(blocked.rejectedReason).toBe('Message rejected by recipient policy.')
	expect(
		await listEmailMessages({ db: env.APP_DB, userId, limit: 10 }),
	).toEqual([])
	expect(await readUserDailyReceiveCount(userId)).toBe(0)
	const rejectEvents = await env.APP_DB.prepare(
		`SELECT event_type, detail_json FROM email_delivery_events WHERE user_id = ?`,
	)
		.bind(userId)
		.all<{ event_type: string; detail_json: string }>()
	const rejectDetails = (rejectEvents.results ?? []).map((row) => ({
		eventType: row.event_type,
		detail: JSON.parse(row.detail_json) as Record<string, unknown>,
	}))
	expect(rejectDetails.every((row) => row.eventType === 'rejected')).toBe(true)
	expect(
		rejectDetails.find((row) => row.detail['aggregate'] !== true)?.detail,
	).toMatchObject({
		reason: 'Message rejected by recipient policy.',
		phase: 'sender-policy',
	})

	const quarantined = createForwardableEmailMessage({
		from: 'news@suspect.example',
		to: address,
		raw: [
			'From: News <news@suspect.example>',
			`To: ${address}`,
			'Subject: Quarantine me',
			'Message-ID: <quarantine@suspect.example>',
			'',
			'Hold this.',
		].join('\r\n'),
	})
	await handleInboundEmail(quarantined, createInboundEnv())
	expect(quarantined.rejectedReason).toBeNull()

	const allowed = createForwardableEmailMessage({
		from: 'friend@example.net',
		to: address,
		raw: [
			'From: Friend <friend@example.net>',
			`To: ${address}`,
			'Subject: Allowed despite DMARC fail',
			'Message-ID: <allow-dmarc@example.net>',
			`Authentication-Results: ${dmarcFailAuthResults()}`,
			'',
			'Trusted sender.',
		].join('\r\n'),
	})
	await handleInboundEmail(allowed, createInboundEnv())
	expect(allowed.rejectedReason).toBeNull()

	const suspect = createForwardableEmailMessage({
		from: 'stranger@example.net',
		to: address,
		raw: [
			'From: Stranger <stranger@example.net>',
			`To: ${address}`,
			'Subject: Suspect auth',
			'Message-ID: <suspect-auth@example.net>',
			`Authentication-Results: ${dmarcFailAuthResults()}`,
			'',
			'Suspect body.',
		].join('\r\n'),
	})
	await handleInboundEmail(suspect, createInboundEnv())

	const clean = createForwardableEmailMessage({
		from: 'stranger@example.net',
		to: address,
		raw: [
			'From: Stranger <stranger@example.net>',
			`To: ${address}`,
			'Subject: No auth header',
			'Message-ID: <no-auth@example.net>',
			'',
			'Clean body.',
		].join('\r\n'),
	})
	await handleInboundEmail(clean, createInboundEnv())

	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId,
		limit: 20,
	})
	const bySubject = Object.fromEntries(
		messages.map((row) => [row.subject, row]),
	)
	expect(bySubject['Quarantine me']).toMatchObject({
		classification: 'quarantined',
		classificationReason: 'Sender matched quarantine rule suspect.example.',
	})
	expect(bySubject['Allowed despite DMARC fail']).toMatchObject({
		classification: 'accepted',
		classificationReason: null,
	})
	expect(bySubject['Suspect auth']).toMatchObject({
		classification: 'quarantined',
		classificationReason: 'Sender failed DMARC authentication.',
	})
	expect(bySubject['No auth header']).toMatchObject({
		classification: 'accepted',
		classificationReason: null,
	})
})

test('user quarantined and accepted messages dispatch matching subscription topics', async () => {
	silenceIncidentalRuntimeWarnings()
	packageSubscriptionMocks.dispatchInboundEmailSubscriptionEvents.mockClear()
	packageSubscriptionMocks.dispatchSystemInboundEmailSubscriptionEvents.mockClear()
	await ensureEmailTestSchema(env.APP_DB)
	const username = `dispatch-${crypto.randomUUID().slice(0, 8)}`
	const accountEmail = `dispatch-${crypto.randomUUID()}@example.com`
	const userId = await seedVerifiedAccount({
		db: env.APP_DB,
		email: accountEmail,
		username,
	})
	const address = `${username}@${platformDomain}`
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId,
		kind: 'address',
		value: 'hold@example.net',
		effect: 'quarantine',
	})

	const { ctx, waitUntilPromises } = createWaitUntilContext()
	const quarantined = createForwardableEmailMessage({
		from: 'hold@example.net',
		to: address,
		raw: [
			'From: Hold <hold@example.net>',
			`To: ${address}`,
			'Subject: Quarantined dispatch',
			'Message-ID: <quarantined-dispatch@example.net>',
			'',
			'Hold body.',
		].join('\r\n'),
	})
	await handleInboundEmail(quarantined, createInboundEnv(), ctx)
	expect(quarantined.rejectedReason).toBeNull()

	const accepted = createForwardableEmailMessage({
		from: 'ok@example.net',
		to: address,
		raw: [
			'From: Ok <ok@example.net>',
			`To: ${address}`,
			'Subject: Accepted dispatch',
			'Message-ID: <accepted-dispatch@example.net>',
			'',
			'Accepted body.',
		].join('\r\n'),
	})
	await handleInboundEmail(accepted, createInboundEnv(), ctx)
	expect(accepted.rejectedReason).toBeNull()

	for (const promise of waitUntilPromises) {
		await promise
	}

	expect(
		packageSubscriptionMocks.dispatchInboundEmailSubscriptionEvents,
	).toHaveBeenCalledTimes(2)
	const dispatched =
		packageSubscriptionMocks.dispatchInboundEmailSubscriptionEvents.mock.calls.map(
			(call) => call[0]?.message,
		)
	expect(
		dispatched.find((message) => message?.subject === 'Quarantined dispatch'),
	).toMatchObject({
		classification: 'quarantined',
		classificationReason: 'Sender matched quarantine rule hold@example.net.',
	})
	expect(
		dispatched.find((message) => message?.subject === 'Accepted dispatch'),
	).toMatchObject({
		classification: 'accepted',
		classificationReason: null,
	})
	expect(
		packageSubscriptionMocks.dispatchSystemInboundEmailSubscriptionEvents,
	).not.toHaveBeenCalled()
})

test('system sender rules reject/block and suppress quarantined subscription dispatch', async () => {
	silenceIncidentalRuntimeWarnings()
	packageSubscriptionMocks.dispatchInboundEmailSubscriptionEvents.mockClear()
	packageSubscriptionMocks.dispatchSystemInboundEmailSubscriptionEvents.mockClear()
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)

	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId: systemEmailOwnerId,
		kind: 'address',
		value: 'blocked@spam.example',
		effect: 'block',
	})
	await upsertEmailSenderRule({
		db: env.APP_DB,
		userId: systemEmailOwnerId,
		kind: 'domain',
		value: 'suspect.example',
		effect: 'quarantine',
	})

	const blocked = createForwardableEmailMessage({
		from: 'blocked@spam.example',
		to: `kody@${systemDomain}`,
		raw: [
			'From: Blocked <blocked@spam.example>',
			`To: kody@${systemDomain}`,
			'Subject: System blocked',
			'Message-ID: <system-blocked@spam.example>',
			'',
			'No.',
		].join('\r\n'),
	})
	await handleInboundEmail(blocked, createInboundEnv())
	expect(blocked.rejectedReason).toBe('Message rejected by recipient policy.')
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId: systemEmailOwnerId,
			limit: 10,
		}),
	).toEqual([])

	const { ctx, waitUntilPromises } = createWaitUntilContext()
	const quarantined = createForwardableEmailMessage({
		from: 'bot@suspect.example',
		to: `postmaster@${systemDomain}`,
		raw: [
			'From: Bot <bot@suspect.example>',
			`To: postmaster@${systemDomain}`,
			'Subject: System quarantine',
			'Message-ID: <system-quarantine@suspect.example>',
			'',
			'Hold for operators.',
		].join('\r\n'),
	})
	await handleInboundEmail(quarantined, createInboundEnv(), ctx)
	expect(quarantined.rejectedReason).toBeNull()
	for (const promise of waitUntilPromises) {
		await promise
	}

	const [stored] = await listEmailMessages({
		db: env.APP_DB,
		userId: systemEmailOwnerId,
		limit: 1,
	})
	expect(stored).toMatchObject({
		classification: 'quarantined',
		classificationReason: 'Sender matched quarantine rule suspect.example.',
	})
	expect(
		packageSubscriptionMocks.dispatchSystemInboundEmailSubscriptionEvents,
	).not.toHaveBeenCalled()
	expect(
		packageSubscriptionMocks.dispatchInboundEmailSubscriptionEvents,
	).not.toHaveBeenCalled()

	const effect = await env.APP_DB.prepare(
		`SELECT
			json_extract(detail_json, '$.subscriptionEffectState') AS subscription_state,
			json_extract(detail_json, '$.subscriptionEffectSuppressedQuarantineAt') AS suppressed_at
		FROM email_delivery_events
		WHERE user_id = ? AND event_type = 'received'
		ORDER BY created_at DESC
		LIMIT 1`,
	)
		.bind(systemEmailOwnerId)
		.first<{ subscription_state: string; suppressed_at: string }>()
	expect(effect?.subscription_state).toBe('complete')
	expect(effect?.suppressed_at).toEqual(expect.any(String))

	const delivery = await env.APP_DB.prepare(
		`SELECT id FROM email_delivery_events
		WHERE user_id = ? AND event_type = 'received'
		ORDER BY created_at DESC
		LIMIT 1`,
	)
		.bind(systemEmailOwnerId)
		.first<{ id: string }>()
	if (!delivery) throw new Error('Expected received system delivery.')
	await processInboundDeliveryEffects({
		env: createInboundEnv(),
		userId: systemEmailOwnerId,
		deliveryId: delivery.id,
	})
	expect(
		packageSubscriptionMocks.dispatchSystemInboundEmailSubscriptionEvents,
	).not.toHaveBeenCalled()
})
