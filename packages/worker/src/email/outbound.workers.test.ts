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

const cloudflareEmailApi =
	'https://api.cloudflare.test/client/v4/accounts/account-123/email/sending/send'

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
