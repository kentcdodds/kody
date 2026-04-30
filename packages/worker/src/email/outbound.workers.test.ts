import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { getEmailDomain } from './address.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import {
	getEmailMessageById,
	listEmailMessages,
	upsertEmailSenderIdentity,
} from './repo.ts'
import { sendOutboundEmail } from './outbound.ts'

test('sendOutboundEmail uses SendEmail binding and stores sent delivery state', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-outbound-user-${crypto.randomUUID()}`
	const from = `sender-${crypto.randomUUID()}@example.com`
	const sent: Array<unknown> = []
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
	})
	const listed = await listEmailMessages({
		db: env.APP_DB,
		userId,
		direction: 'outbound',
		limit: 5,
	})
	expect(listed.map((message) => message.id)).toContain(result.message.id)
})

test('sendOutboundEmail does not fall back when binding sends without message id', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-outbound-null-id-user-${crypto.randomUUID()}`
	const from = `sender-${crypto.randomUUID()}@example.com`
	let bindingSendCount = 0
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async () => {
		throw new Error('REST fallback should not be called')
	}) as typeof fetch
	try {
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
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('sendOutboundEmail preserves reply headers and records failed fallback sends', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-outbound-fallback-user-${crypto.randomUUID()}`
	const from = `sender-${crypto.randomUUID()}@example.com`
	const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = []
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		fetchCalls.push({
			url: String(input),
			body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
		})
		return new Response(
			JSON.stringify({
				success: false,
				errors: [{ message: 'provider down' }],
			}),
			{ status: 500, headers: { 'content-type': 'application/json' } },
		)
	}) as typeof fetch

	try {
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
			replyTo: 'reply@example.com',
			headers: {
				'In-Reply-To': original.message.messageIdHeader,
				References: '<root@example.com>',
			},
		})
		const stored = await getEmailMessageById({
			db: env.APP_DB,
			userId,
			messageId: result.message.id,
		})
		expect(stored).toMatchObject({
			processingStatus: 'failed',
			error: 'provider down',
		})
	} finally {
		globalThis.fetch = originalFetch
	}
})

