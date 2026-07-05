import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { getEmailDomain } from './address.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import {
	getEmailMessageById,
	listEmailMessages,
	upsertEmailSenderIdentity,
} from './repo.ts'
import { sendOutboundEmail } from './outbound.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import {
	incrementDailyEntitlementCounter,
	utcDayKey,
} from '#worker/entitlements/service.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const cloudflareEmailApi =
	'https://api.cloudflare.test/client/v4/accounts/account-123/email/sending/send'

function createBindingSendEnv() {
	return {
		...env,
		EMAIL: {
			async send() {
				return { messageId: 'provider-message-entitlement' }
			},
		},
	}
}

async function insertTestUser(input: {
	email: string
	plan: 'personal' | null
}) {
	const username = `email-entitlement-${crypto.randomUUID().slice(0, 8)}`
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, plan)
			VALUES (?, ?, ?, ?)`,
	)
		.bind(username, input.email, 'test-password-hash', input.plan)
		.run()
}

async function readDailyEmailSendCounter(userId: string) {
	const row = await env.APP_DB.prepare(
		`SELECT count FROM entitlement_daily_counters
			WHERE user_id = ? AND resource = ? AND day = ?`,
	)
		.bind(userId, 'email_sends_per_day', utcDayKey())
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

async function seedVerifiedSender(userId: string) {
	const from = `sender-${crypto.randomUUID()}@example.com`
	await upsertEmailSenderIdentity({
		db: env.APP_DB,
		userId,
		email: from,
		domain: getEmailDomain(from),
		status: 'verified',
	})
	return from
}

async function sendTestOutboundEmail(input: {
	userId: string
	from: string
	userEmail?: string | null
}) {
	return await sendOutboundEmail({
		env: createBindingSendEnv(),
		userId: input.userId,
		userEmail: input.userEmail,
		from: input.from,
		to: 'recipient@example.com',
		subject: 'Entitlement test',
		text: 'Body',
	})
}

function restFallbackMustNotRunHandler() {
	return http.post(cloudflareEmailApi, () => {
		throw new Error('REST fallback should not be called')
	})
}

test('sendOutboundEmail uses SendEmail binding and stores sent delivery state', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-outbound-user-${crypto.randomUUID()}`
	const from = `sender-${crypto.randomUUID()}@example.com`
	const sent: Array<EmailMessage> = []
	const sendEnv = {
		...env,
		EMAIL: {
			async send(message: EmailMessage) {
				sent.push(message)
				return { messageId: 'provider-message-123' }
			},
		},
	}
	await upsertEmailSenderIdentity({
		db: env.APP_DB,
		userId,
		email: from,
		domain: getEmailDomain(from),
		status: 'verified',
	})

	const result = await sendOutboundEmail({
		env: sendEnv,
		userId,
		from,
		to: 'recipient@example.com',
		subject: 'Hello from Kody',
		text: 'Body',
	})

	expect(sent).toHaveLength(1)
	expect(sent[0]?.to).toBe('recipient@example.com')
	expect(sent[0]?.headers).toEqual({})
	expect(result.status).toBe('sent')
	expect(result.providerMessageId).toBe('provider-message-123')
	const stored = await getEmailMessageById({
		db: env.APP_DB,
		userId,
		messageId: result.message.id,
	})
	expect(stored).toMatchObject({
		direction: 'outbound',
		processingStatus: 'sent',
		providerMessageId: 'provider-message-123',
		fromAddress: from,
		headers: {
			'Message-ID': result.message.messageIdHeader,
			'X-Kody-Email-Message-Id': result.message.messageIdHeader,
		},
	})
	const listed = await listEmailMessages({
		db: env.APP_DB,
		userId,
		direction: 'outbound',
		limit: 5,
	})
	expect(listed.map((message) => message.id)).toContain(result.message.id)
})

test('sendOutboundEmail skips REST fallback when the binding succeeds or validation fails first', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const mswOptions = { onUnhandledRequest: 'bypass' as const }

	{
		const userId = `email-outbound-null-id-user-${crypto.randomUUID()}`
		const from = `sender-${crypto.randomUUID()}@example.com`
		let bindingSendCount = 0

		using _server = createMswNodeServer(
			[restFallbackMustNotRunHandler()],
			mswOptions,
		)
		await upsertEmailSenderIdentity({
			db: env.APP_DB,
			userId,
			email: from,
			domain: getEmailDomain(from),
			status: 'verified',
		})
		const result = await sendOutboundEmail({
			env: {
				...env,
				EMAIL: {
					async send() {
						bindingSendCount += 1
						return { messageId: null as unknown as string }
					},
				},
			},
			userId,
			from,
			to: 'recipient@example.com',
			subject: 'No provider id',
			text: 'Body',
		})
		expect(bindingSendCount).toBe(1)
		expect(result).toMatchObject({
			status: 'sent',
			providerMessageId: null,
			error: null,
		})
	}

	{
		const userId = `email-outbound-empty-body-user-${crypto.randomUUID()}`
		const from = `sender-${crypto.randomUUID()}@example.com`

		using _server = createMswNodeServer(
			[restFallbackMustNotRunHandler()],
			mswOptions,
		)
		await upsertEmailSenderIdentity({
			db: env.APP_DB,
			userId,
			email: from,
			domain: getEmailDomain(from),
			status: 'verified',
		})

		await expect(
			sendOutboundEmail({
				env: {
					...env,
					EMAIL: undefined as unknown as SendEmail,
					CLOUDFLARE_ACCOUNT_ID: 'account-123',
					CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
					CLOUDFLARE_API_TOKEN: 'token-123',
				},
				userId,
				from,
				to: 'recipient@example.com',
				subject: 'Missing body',
				text: '   ',
			}),
		).rejects.toThrow('Email text or HTML body is required.')
	}
})

test('sendOutboundEmail preserves reply headers and records failed fallback sends', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-outbound-fallback-user-${crypto.randomUUID()}`
	const from = `sender-${crypto.randomUUID()}@example.com`
	const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = []

	using _server = createMswNodeServer(
		[
			http.post(cloudflareEmailApi, async ({ request }) => {
				fetchCalls.push({
					url: request.url,
					body: (await request.json()) as Record<string, unknown>,
				})
				return HttpResponse.json(
					{
						success: false,
						errors: [{ message: 'provider down' }],
					},
					{ status: 500 },
				)
			}),
		],
		{ onUnhandledRequest: 'bypass' },
	)
	await upsertEmailSenderIdentity({
		db: env.APP_DB,
		userId,
		email: from,
		domain: getEmailDomain(from),
		status: 'verified',
	})
	const original = await sendOutboundEmail({
		env: {
			...env,
			EMAIL: {
				async send() {
					return { messageId: 'original-provider-message' }
				},
			},
		},
		userId,
		from,
		to: 'recipient@example.com',
		subject: 'Hello from Kody',
		text: 'Original body',
	})

	const result = await sendOutboundEmail({
		env: {
			...env,
			EMAIL: undefined as unknown as SendEmail,
			CLOUDFLARE_ACCOUNT_ID: 'account-123',
			CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
			CLOUDFLARE_API_TOKEN: 'token-123',
		},
		userId,
		from,
		to: 'recipient@example.com',
		subject: 'Re: Hello from Kody',
		text: 'Body',
		replyTo: 'reply@example.com',
		inReplyToHeader: original.message.messageIdHeader,
		references: ['<root@example.com>'],
	})

	expect(result.status).toBe('failed')
	expect(result.error).toBe('provider down')
	expect(fetchCalls).toHaveLength(1)
	expect(fetchCalls[0]?.body).toMatchObject({
		html: 'Body',
		replyTo: 'reply@example.com',
		headers: {
			'In-Reply-To': original.message.messageIdHeader,
			References: '<root@example.com>',
		},
	})
	expect(fetchCalls[0]?.body.headers).not.toHaveProperty('Message-ID')
	expect(fetchCalls[0]?.body.headers).not.toHaveProperty(
		'X-Kody-Email-Message-Id',
	)
	const stored = await getEmailMessageById({
		db: env.APP_DB,
		userId,
		messageId: result.message.id,
	})
	expect(stored).toMatchObject({
		processingStatus: 'failed',
		error: 'provider down',
		headers: {
			'Message-ID': result.message.messageIdHeader,
			'X-Kody-Email-Message-Id': result.message.messageIdHeader,
			'In-Reply-To': original.message.messageIdHeader,
			References: '<root@example.com>',
		},
	})
})

test('sendOutboundEmail enforces email_sends_per_day for plan users at the limit', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `planned-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.personal.maxEmailSendsPerDay
	if (limit === null)
		throw new Error('Expected a numeric personal email limit.')
	await insertTestUser({ email, plan: 'personal' })
	const from = await seedVerifiedSender(userId)
	await env.APP_DB.prepare(
		`INSERT INTO entitlement_daily_counters (user_id, resource, day, count, updated_at)
			VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			userId,
			'email_sends_per_day',
			utcDayKey(),
			limit,
			new Date().toISOString(),
		)
		.run()

	const error = await sendTestOutboundEmail({
		userId,
		from,
		userEmail: email,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!isEntitlementLimitError(error)) {
		throw new Error('Expected an EntitlementLimitError from sendOutboundEmail.')
	}
	expect(error.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'email_sends_per_day',
		plan: 'personal',
		limit,
		current: limit,
	})
	expect(error.message).toContain(`at most ${limit} email sends per day`)
})

test('sendOutboundEmail increments the daily counter when under the plan limit', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `under-limit-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await insertTestUser({ email, plan: 'personal' })
	const from = await seedVerifiedSender(userId)
	expect(await readDailyEmailSendCounter(userId)).toBe(0)

	const result = await sendTestOutboundEmail({
		userId,
		from,
		userEmail: email,
	})

	expect(result.status).toBe('sent')
	expect(await readDailyEmailSendCounter(userId)).toBe(1)
})

test('sendOutboundEmail stays unlimited for NULL-plan users while still counting attempts', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const limit = planLimits.personal.maxEmailSendsPerDay
	if (limit === null)
		throw new Error('Expected a numeric personal email limit.')

	{
		const email = `legacy-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(email)
		await insertTestUser({ email, plan: null })
		const from = await seedVerifiedSender(userId)
		for (let index = 0; index < limit; index += 1) {
			await incrementDailyEntitlementCounter({
				db: env.APP_DB,
				userId,
				resource: 'email_sends_per_day',
			})
		}
		expect(await readDailyEmailSendCounter(userId)).toBe(limit)

		const result = await sendTestOutboundEmail({
			userId,
			from,
			userEmail: email,
		})
		expect(result.status).toBe('sent')
		expect(await readDailyEmailSendCounter(userId)).toBe(limit + 1)
	}

	{
		const userId = `email-outbound-no-email-${crypto.randomUUID()}`
		const from = await seedVerifiedSender(userId)
		for (let index = 0; index < limit; index += 1) {
			await incrementDailyEntitlementCounter({
				db: env.APP_DB,
				userId,
				resource: 'email_sends_per_day',
			})
		}
		expect(await readDailyEmailSendCounter(userId)).toBe(limit)

		const result = await sendTestOutboundEmail({
			userId,
			from,
		})
		expect(result.status).toBe('sent')
		expect(await readDailyEmailSendCounter(userId)).toBe(limit + 1)
	}
})
