import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import type * as UserLookupModule from '#worker/identity/user-lookup.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { handleInboundEmail } from './inbound.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const platformBaseUrl = 'https://kody.example.com'
const platformDomain = 'inbox.kody.example.com'

const userLookupMockModule = vi.hoisted(() => ({
	findPublicUserIdentityByUsername: vi.fn(),
}))

vi.mock('#worker/identity/user-lookup.ts', async () => {
	const actual = await vi.importActual<typeof UserLookupModule>(
		'#worker/identity/user-lookup.ts',
	)
	return {
		...actual,
		findPublicUserIdentityByUsername: (
			...args: Parameters<typeof actual.findPublicUserIdentityByUsername>
		) => userLookupMockModule.findPublicUserIdentityByUsername(...args),
	}
})

function createInboundEnv() {
	return { ...env, APP_BASE_URL: platformBaseUrl }
}

async function seedAccount(input: {
	username: string
	email: string
	plan: 'free' | 'max'
	emailVerifiedAt: string | null
	stableUserId: string
}) {
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan, stable_user_id)
			VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			input.username,
			input.email,
			'test-password-hash',
			input.emailVerifiedAt,
			input.plan,
			input.stableUserId,
		)
		.run()
}

test('inbound account plan/verification requires matching email and stable_user_id (per-user isolation)', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)

	const otherEmail = `other-plan-${crypto.randomUUID()}@example.com`
	const otherUserId = await createStableUserIdFromEmail(otherEmail)
	const otherUsername = `other-${crypto.randomUUID().slice(0, 8)}`
	await seedAccount({
		username: otherUsername,
		email: otherEmail,
		plan: 'max',
		emailVerifiedAt: new Date().toISOString(),
		stableUserId: otherUserId,
	})

	const recipientEmail = `recipient-${crypto.randomUUID()}@example.com`
	const recipientUserId = await createStableUserIdFromEmail(recipientEmail)
	const recipientUsername = `recv-${crypto.randomUUID().slice(0, 8)}`
	await seedAccount({
		username: recipientUsername,
		email: recipientEmail,
		plan: 'free',
		emailVerifiedAt: null,
		stableUserId: recipientUserId,
	})

	userLookupMockModule.findPublicUserIdentityByUsername.mockImplementation(
		async () => ({
			userId: 0,
			username: recipientUsername,
			// Stale / mismatched grant-style pair: another account's email with
			// this mailbox owner's stable id must not load that other plan or
			// verified state.
			email: otherEmail,
			mcpUserId: recipientUserId,
		}),
	)

	const address = `${recipientUsername}@${platformDomain}`
	const message = createForwardableEmailMessage({
		from: 'stranger@example.net',
		to: address,
		raw: [
			'From: Stranger <stranger@example.net>',
			`To: ${address}`,
			'Subject: Cross-account plan probe',
			`Message-ID: <isolation-${crypto.randomUUID()}@example.net>`,
			'',
			'Must not inherit another account verification or plan.',
		].join('\r\n'),
	})
	await handleInboundEmail(message, createInboundEnv())

	// Dual-scoped miss → unverified gate (not the other account's verified/max).
	expect(message.rejectedReason).toBe('Account email is not verified.')

	const recipientMailbox = mailboxRpc({ env, userId: recipientUserId })
	const otherMailbox = mailboxRpc({ env, userId: otherUserId })
	expect(await recipientMailbox.listMessages({ limit: 10 })).toMatchObject({
		messages: [],
	})
	expect(await otherMailbox.listMessages({ limit: 10 })).toMatchObject({
		messages: [],
	})

	const recipientEvents = await recipientMailbox.listDeliveryEvents({
		limit: 10,
	})
	expect(recipientEvents.map((event) => JSON.parse(event.detailJson))).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				reason: 'Account email is not verified.',
				phase: 'account-verification',
			}),
		]),
	)

	expect(await otherMailbox.listDeliveryEvents({ limit: 10 })).toEqual([])
})
