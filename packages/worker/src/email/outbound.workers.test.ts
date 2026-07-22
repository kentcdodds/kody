import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import {
	deleteEmailMessageById,
	getEmailAttachmentById,
	getEmailMessageById,
	insertEmailMessage,
	listEmailAttachmentsForMessage,
	listEmailMessages,
} from './repo.ts'
import {
	maxOutboundEmailAttachmentTotalBytes,
	sendOutboundEmail,
} from './outbound.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import {
	nullPlanEmailFallbackLimits,
	planLimits,
} from '#worker/entitlements/plans.ts'
import { incrementDailyEntitlementCounter } from '#worker/entitlements/service.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const cloudflareEmailApi =
	'https://api.cloudflare.test/client/v4/accounts/account-123/email/sending/send'

const platformBaseUrl = 'https://kody.example.com'
// User mail lives on the inbox. subdomain derived from APP_BASE_URL.
const platformDomain = 'inbox.kody.example.com'

function createBindingSendEnv() {
	return {
		...env,
		APP_BASE_URL: platformBaseUrl,
		EMAIL: {
			async send() {
				return { messageId: 'provider-message-entitlement' }
			},
		},
	}
}

async function seedVerifiedAccount(input: {
	email: string
	username?: string
	plan?: 'pro' | null
	verified?: boolean
}) {
	const username = input.username ?? `sender-${crypto.randomUUID().slice(0, 8)}`
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan, stable_user_id)
			VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			username,
			input.email,
			'test-password-hash',
			input.verified === false ? null : new Date().toISOString(),
			input.plan ?? null,
			stableUserId,
		)
		.run()
	return { username, from: `${username}@${platformDomain}` }
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

async function sendSelfNotification(input: {
	userId: string
	accountEmail: string
}) {
	return await sendOutboundEmail({
		env: createBindingSendEnv(),
		userId: input.userId,
		accountEmail: input.accountEmail,
		recipientPolicy: 'self',
		subject: 'Entitlement test',
		text: 'Body',
	})
}

async function listEmailSendRollups(db: D1Database, userId: string) {
	const { results } = await db
		.prepare(
			`SELECT user_id, metric, month, event_count, error_count,
				total_duration_ms, total_cpu_ms, total_bytes
			FROM usage_rollups
			WHERE user_id = ?1 AND metric = 'email_send'
			ORDER BY month`,
		)
		.bind(userId)
		.all()
	return results
}

function restFallbackMustNotRunHandler() {
	return http.post(cloudflareEmailApi, () => {
		throw new Error('REST fallback should not be called')
	})
}

test('sendOutboundEmail sends from the platform-assigned username address to the account email', async () => {
	// Usage recording degrades with a warn when the usage_rollups table is
	// not part of this test's schema; that is incidental to sending.
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `account-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const { from } = await seedVerifiedAccount({ email: accountEmail })
	const sent: Array<EmailMessage> = []
	const sendEnv = {
		...env,
		APP_BASE_URL: platformBaseUrl,
		EMAIL: {
			async send(message: EmailMessage) {
				sent.push(message)
				return { messageId: 'provider-message-123' }
			},
		},
	}

	const result = await sendOutboundEmail({
		env: sendEnv,
		userId,
		accountEmail,
		recipientPolicy: 'self',
		subject: 'Hello from Kody',
		text: 'Body',
	})

	expect(sent).toHaveLength(1)
	expect(sent[0]?.to).toBe(accountEmail)
	expect(sent[0]?.from).toBe(from)
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
		toAddresses: [accountEmail],
		headers: {
			'Message-ID': result.message.messageIdHeader,
			'X-Kody-Email-Message-Id': result.message.messageIdHeader,
		},
	})
	// Outbound sends store parsed bodies only: nothing to offload to the
	// EMAIL_BLOBS bucket even though the binding is available.
	expect(stored?.rawMime).toBeNull()
	expect(stored?.rawMimeKey).toBeNull()
	// The send auto-provisioned (and referenced) the platform sender
	// identity — no self-service verify step exists.
	expect(stored?.senderIdentityId).toBeTruthy()
	const identity = await env.APP_DB.prepare(
		`SELECT user_id, email, domain, status FROM email_sender_identities WHERE id = ?`,
	)
		.bind(stored?.senderIdentityId)
		.first<Record<string, unknown>>()
	expect(identity).toEqual({
		user_id: userId,
		email: from,
		domain: platformDomain,
		status: 'verified',
	})
	const listed = await listEmailMessages({
		db: env.APP_DB,
		userId,
		direction: 'outbound',
		limit: 5,
	})
	expect(listed.map((message) => message.id)).toContain(result.message.id)
})

test('sendOutboundEmail rejects non-self recipients under the self policy', async () => {
	// Usage recording degrades with a warn when the usage_rollups table is
	// not part of this test's schema; that is incidental to the policy.
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `account-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	await seedVerifiedAccount({ email: accountEmail })

	await expect(
		sendOutboundEmail({
			env: createBindingSendEnv(),
			userId,
			accountEmail,
			recipientPolicy: 'self',
			to: 'someone-else@example.net',
			subject: 'Blocked',
			text: 'Body',
		}),
	).rejects.toThrow(
		`email_send only delivers to your own account email (${accountEmail})`,
	)
	// Malformed explicit recipients are rejected instead of silently dropped
	// (a dropped value would fall back to the account email).
	await expect(
		sendOutboundEmail({
			env: createBindingSendEnv(),
			userId,
			accountEmail,
			recipientPolicy: 'self',
			to: 'not-an-email',
			subject: 'Blocked',
			text: 'Body',
		}),
	).rejects.toThrow('Invalid recipient email address: not-an-email')
	// Providing the own account email explicitly is allowed.
	const allowed = await sendOutboundEmail({
		env: createBindingSendEnv(),
		userId,
		accountEmail,
		recipientPolicy: 'self',
		to: accountEmail.toUpperCase(),
		subject: 'Allowed',
		text: 'Body',
	})
	expect(allowed.status).toBe('sent')
	expect(allowed.message.toAddresses).toEqual([accountEmail])
})

test('sendOutboundEmail blocks reserved usernames and unconfigured platform domains', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `system-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	await seedVerifiedAccount({ email: accountEmail })
	// A legacy account holding a reserved username cannot send user mail.
	const reservedEmail = `reserved-${crypto.randomUUID()}@example.com`
	const reservedUserId = await createStableUserIdFromEmail(reservedEmail)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(username) DO UPDATE SET
				email = excluded.email,
				email_verified_at = excluded.email_verified_at,
				stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id)`,
	)
		.bind(
			'kody',
			reservedEmail,
			'test-password-hash',
			new Date().toISOString(),
			reservedUserId,
		)
		.run()
	await expect(
		sendOutboundEmail({
			env: createBindingSendEnv(),
			userId: reservedUserId,
			accountEmail: reservedEmail,
			recipientPolicy: 'self',
			subject: 'Blocked',
			text: 'Body',
		}),
	).rejects.toThrow('Reserved usernames cannot send email')

	await expect(
		sendOutboundEmail({
			env: { ...createBindingSendEnv(), APP_BASE_URL: undefined },
			userId,
			accountEmail,
			recipientPolicy: 'self',
			subject: 'Blocked',
			text: 'Body',
		}),
	).rejects.toThrow('no platform email domain is configured')
})

test('sendOutboundEmail skips REST fallback when the binding succeeds or validation fails first', async () => {
	// Usage recording degrades with a warn when the usage_rollups table is
	// not part of this test's schema; that is incidental to the fallback.
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const mswOptions = { onUnhandledRequest: 'bypass' as const }

	{
		const accountEmail = `account-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(accountEmail)
		let bindingSendCount = 0

		using _server = createMswNodeServer(
			[restFallbackMustNotRunHandler()],
			mswOptions,
		)
		await seedVerifiedAccount({ email: accountEmail })
		const result = await sendOutboundEmail({
			env: {
				...env,
				APP_BASE_URL: platformBaseUrl,
				EMAIL: {
					async send() {
						bindingSendCount += 1
						return { messageId: null as unknown as string }
					},
				},
			},
			userId,
			accountEmail,
			recipientPolicy: 'self',
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
		const accountEmail = `account-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(accountEmail)

		using _server = createMswNodeServer(
			[restFallbackMustNotRunHandler()],
			mswOptions,
		)
		await seedVerifiedAccount({ email: accountEmail })

		await expect(
			sendOutboundEmail({
				env: {
					...env,
					APP_BASE_URL: platformBaseUrl,
					EMAIL: undefined as unknown as SendEmail,
					CLOUDFLARE_ACCOUNT_ID: 'account-123',
					CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
					CLOUDFLARE_API_TOKEN: 'token-123',
				},
				userId,
				accountEmail,
				recipientPolicy: 'self',
				subject: 'Missing body',
				text: '   ',
			}),
		).rejects.toThrow('Email text or HTML body is required.')
	}
})

test('sendOutboundEmail blocks unverified accounts', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `unverified-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	let bindingSendCount = 0

	await seedVerifiedAccount({ email: accountEmail, verified: false })

	await expect(
		sendOutboundEmail({
			env: {
				...env,
				APP_BASE_URL: platformBaseUrl,
				EMAIL: {
					async send() {
						bindingSendCount += 1
						return { messageId: 'provider-message-123' }
					},
				},
			},
			userId,
			accountEmail,
			recipientPolicy: 'self',
			subject: 'Blocked',
			text: 'Body',
		}),
	).rejects.toThrow('Account email must be verified before sending email.')
	expect(bindingSendCount).toBe(0)
})

test('sendOutboundEmail preserves reply headers and records failed fallback sends', async () => {
	silenceIncidentalRuntimeWarnings(['cloudflare-email-api-failed'])
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const isolatedUserId = `email-outbound-isolated-user-${crypto.randomUUID()}`
	const accountEmail = `account-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = []
	const month = new Date().toISOString().slice(0, 7)
	const originalBodyBytes = new TextEncoder().encode('Original body').byteLength
	const replyBodyBytes = new TextEncoder().encode('Body').byteLength

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
	await seedVerifiedAccount({ email: accountEmail })
	const original = await sendOutboundEmail({
		env: {
			...env,
			APP_BASE_URL: platformBaseUrl,
			EMAIL: {
				async send() {
					return { messageId: 'original-provider-message' }
				},
			},
		},
		userId,
		accountEmail,
		recipientPolicy: 'self',
		subject: 'Hello from Kody',
		text: 'Original body',
	})
	const inbound = await insertEmailMessage({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		message: {
			direction: 'inbound',
			userId,
			fromAddress: 'recipient@example.com',
			envelopeFrom: 'recipient@example.com',
			toAddresses: [accountEmail],
			subject: 'Hello from Kody',
			messageIdHeader: '<inbound-root@example.com>',
			processingStatus: 'stored',
			receivedAt: new Date().toISOString(),
		},
	})

	const result = await sendOutboundEmail({
		env: {
			...env,
			APP_BASE_URL: platformBaseUrl,
			EMAIL: undefined as unknown as SendEmail,
			CLOUDFLARE_ACCOUNT_ID: 'account-123',
			CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
			CLOUDFLARE_API_TOKEN: 'token-123',
		},
		userId,
		accountEmail,
		recipientPolicy: 'reply',
		replyToMessageId: inbound.id,
		subject: 'Re: Hello from Kody',
		text: 'Body',
		replyTo: 'reply@example.com',
		inReplyToHeader: inbound.messageIdHeader,
		references: ['<root@example.com>'],
	})

	expect(result.status).toBe('failed')
	expect(result.error).toBe('provider down')
	// The failed REST fallback is warned for operators.
	expect(consoleWarn).toHaveBeenCalledWith(
		'cloudflare-email-api-failed',
		expect.any(String),
	)
	// The recipient is always derived from the stored inbound message.
	expect(result.message.toAddresses).toEqual(['recipient@example.com'])
	expect(fetchCalls).toHaveLength(1)
	expect(fetchCalls[0]?.body).toMatchObject({
		html: 'Body',
		to: 'recipient@example.com',
		replyTo: 'reply@example.com',
		headers: {
			'In-Reply-To': inbound.messageIdHeader,
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
			'In-Reply-To': inbound.messageIdHeader,
			References: '<root@example.com>',
		},
	})

	// Replying to an outbound (self) message is rejected: the reply policy
	// only binds to stored inbound mail.
	await expect(
		sendOutboundEmail({
			env: createBindingSendEnv(),
			userId,
			accountEmail,
			recipientPolicy: 'reply',
			replyToMessageId: original.message.id,
			subject: 'Re: Hello from Kody',
			text: 'Body',
		}),
	).rejects.toThrow('Replying requires a stored inbound message.')

	expect(await listEmailSendRollups(env.APP_DB, userId)).toEqual([
		{
			user_id: userId,
			metric: 'email_send',
			month,
			event_count: 2,
			error_count: 1,
			total_duration_ms: expect.any(Number),
			total_cpu_ms: 0,
			total_bytes: originalBodyBytes + replyBodyBytes,
		},
	])
	expect(
		(await listEmailSendRollups(env.APP_DB, isolatedUserId))[0],
	).toBeUndefined()
})

test('sendOutboundEmail sends, stores, and re-serves reply attachments', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const accountEmail = `account-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	await seedVerifiedAccount({ email: accountEmail })
	const inbound = await insertEmailMessage({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		message: {
			direction: 'inbound',
			userId,
			fromAddress: 'recipient@example.com',
			envelopeFrom: 'recipient@example.com',
			toAddresses: [accountEmail],
			subject: 'Needs a file',
			messageIdHeader: '<inbound-attach@example.com>',
			processingStatus: 'stored',
			receivedAt: new Date().toISOString(),
		},
	})
	const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])
	const sent: Array<Record<string, unknown>> = []
	const sendEnv = {
		...env,
		APP_BASE_URL: platformBaseUrl,
		EMAIL: {
			async send(message: Record<string, unknown>) {
				sent.push(message)
				return { messageId: 'provider-attach-1' }
			},
		} as unknown as SendEmail,
	}

	const result = await sendOutboundEmail({
		env: sendEnv,
		userId,
		accountEmail,
		recipientPolicy: 'reply',
		replyToMessageId: inbound.id,
		subject: 'Re: Needs a file',
		text: 'File attached.',
		attachments: [
			{
				filename: 'invoice.pdf',
				contentType: 'application/pdf',
				contentBase64: bytesToBase64(pdfBytes),
			},
		],
	})

	expect(result.status).toBe('sent')
	// The binding receives raw bytes (string content would be treated as
	// raw text, not base64).
	expect(sent).toHaveLength(1)
	const sentAttachments = sent[0]?.attachments as Array<Record<string, unknown>>
	expect(sentAttachments).toHaveLength(1)
	expect(sentAttachments[0]).toMatchObject({
		disposition: 'attachment',
		filename: 'invoice.pdf',
		type: 'application/pdf',
	})
	expect(new Uint8Array(sentAttachments[0]?.content as Uint8Array)).toEqual(
		pdfBytes,
	)

	// The attachment is stored as its own R2 object and stays readable via
	// the normal attachment read path.
	const stored = await listEmailAttachmentsForMessage({
		db: env.APP_DB,
		messageId: result.message.id,
	})
	expect(stored).toHaveLength(1)
	expect(stored[0]).toMatchObject({
		filename: 'invoice.pdf',
		contentType: 'application/pdf',
		disposition: 'attachment',
		size: pdfBytes.byteLength,
		storageKind: 'external',
	})
	const storageKey = stored[0]?.storageKey
	expect(storageKey).toContain(`email-attachment:v1:${userId}/`)
	const loaded = await getEmailAttachmentById({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		userId,
		attachmentId: stored[0]!.id,
	})
	expect(loaded?.contentBase64).toBe(bytesToBase64(pdfBytes))

	// Usage bytes include the attachment payload.
	const rollups = await listEmailSendRollups(env.APP_DB, userId)
	expect(rollups[0]).toMatchObject({
		total_bytes:
			new TextEncoder().encode('File attached.').byteLength +
			pdfBytes.byteLength,
	})

	// Deleting the message removes the external attachment blob too.
	await deleteEmailMessageById({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		messageId: result.message.id,
	})
	expect(await env.EMAIL_BLOBS.get(storageKey!)).toBeNull()
	expect(
		await listEmailAttachmentsForMessage({
			db: env.APP_DB,
			messageId: result.message.id,
		}),
	).toEqual([])
})

test('sendOutboundEmail passes base64 attachments to the REST fallback', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `account-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	await seedVerifiedAccount({ email: accountEmail })
	const contentBase64 = bytesToBase64(new TextEncoder().encode('name,total'))
	const fetchCalls: Array<Record<string, unknown>> = []

	using _server = createMswNodeServer(
		[
			http.post(cloudflareEmailApi, async ({ request }) => {
				fetchCalls.push((await request.json()) as Record<string, unknown>)
				return HttpResponse.json({
					success: true,
					result: { message_id: 'rest-attach-1' },
				})
			}),
		],
		{ onUnhandledRequest: 'bypass' },
	)

	const result = await sendOutboundEmail({
		env: {
			...env,
			APP_BASE_URL: platformBaseUrl,
			EMAIL: undefined as unknown as SendEmail,
			CLOUDFLARE_ACCOUNT_ID: 'account-123',
			CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.test',
			CLOUDFLARE_API_TOKEN: 'token-123',
		},
		userId,
		accountEmail,
		recipientPolicy: 'self',
		subject: 'Report',
		text: 'Report attached.',
		attachments: [
			{
				filename: 'report.csv',
				contentType: 'text/csv',
				contentBase64,
			},
		],
	})

	expect(result.status).toBe('sent')
	expect(result.providerMessageId).toBe('rest-attach-1')
	expect(fetchCalls).toHaveLength(1)
	expect(fetchCalls[0]?.attachments).toEqual([
		{
			content: contentBase64,
			filename: 'report.csv',
			type: 'text/csv',
			disposition: 'attachment',
		},
	])
})

test('sendOutboundEmail rejects invalid and oversized attachments', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `account-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	await seedVerifiedAccount({ email: accountEmail })

	await expect(
		sendOutboundEmail({
			env: createBindingSendEnv(),
			userId,
			accountEmail,
			recipientPolicy: 'self',
			subject: 'Bad base64',
			text: 'Body',
			attachments: [
				{
					filename: 'broken.bin',
					contentType: 'application/octet-stream',
					contentBase64: '!!not-base64!!',
				},
			],
		}),
	).rejects.toThrow('Attachment content must be valid base64: broken.bin')

	// Attachments put the message under the plan-less per-message backstop
	// (email_message_bytes) that body-only sends are not subject to.
	const oversize = new Uint8Array(
		nullPlanEmailFallbackLimits.email_message_bytes + 1,
	)
	const error = await sendOutboundEmail({
		env: createBindingSendEnv(),
		userId,
		accountEmail,
		recipientPolicy: 'self',
		subject: 'Too big',
		text: 'Body',
		attachments: [
			{
				filename: 'huge.bin',
				contentType: 'application/octet-stream',
				contentBase64: bytesToBase64(oversize),
			},
		],
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!isEntitlementLimitError(error)) {
		throw new Error('Expected an EntitlementLimitError from sendOutboundEmail.')
	}
	expect(error.details).toMatchObject({
		resource: 'email_message_bytes',
	})
	// Attachments whose base64 length alone exceeds the 5 MiB hard cap are
	// rejected before any decoding (no entitlement lookup, no allocation).
	const hardCapBase64Length = Math.ceil(
		((maxOutboundEmailAttachmentTotalBytes + 3) * 4) / 3,
	)
	await expect(
		sendOutboundEmail({
			env: createBindingSendEnv(),
			userId,
			accountEmail,
			recipientPolicy: 'self',
			subject: 'Way too big',
			text: 'Body',
			attachments: [
				{
					filename: 'giant.bin',
					contentType: 'application/octet-stream',
					contentBase64: 'A'.repeat(hardCapBase64Length),
				},
			],
		}),
	).rejects.toThrow('exceed the 5 MiB combined limit')

	// None of the failures consumed the daily send quota or stored a message.
	expect(await readDailyEmailSendCounter(userId)).toBe(0)
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId,
			direction: 'outbound',
			limit: 5,
		}),
	).toEqual([])
})

test('sendOutboundEmail enforces email_sends_per_day for plan users at the limit', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `planned-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.pro.maxEmailSendsPerDay
	if (limit === null) throw new Error('Expected a numeric pro email limit.')
	await seedVerifiedAccount({ email, plan: 'pro' })
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

	const error = await sendSelfNotification({
		userId,
		accountEmail: email,
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
		plan: 'pro',
		limit,
		current: limit,
	})
	expect(error.message).toContain(`at most ${limit} email sends per day`)
})

test('sendOutboundEmail binds plan limits even when the caller context has no account email', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `contextless-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.pro.maxEmailSendsPerDay
	if (limit === null) throw new Error('Expected a numeric pro email limit.')
	await seedVerifiedAccount({ email, plan: 'pro' })
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

	// Package subscription contexts pass an empty account email; the plan
	// limit must still apply (no fallback-limit bypass).
	const error = await sendOutboundEmail({
		env: createBindingSendEnv(),
		userId,
		accountEmail: '',
		recipientPolicy: 'self',
		subject: 'Entitlement test',
		text: 'Body',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!isEntitlementLimitError(error)) {
		throw new Error('Expected an EntitlementLimitError from sendOutboundEmail.')
	}
	expect(error.details).toMatchObject({
		resource: 'email_sends_per_day',
		plan: 'pro',
		limit,
	})
})

test('sendOutboundEmail increments the daily counter when under the plan limit', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `under-limit-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedVerifiedAccount({ email, plan: 'pro' })
	expect(await readDailyEmailSendCounter(userId)).toBe(0)

	const result = await sendSelfNotification({
		userId,
		accountEmail: email,
	})

	expect(result.status).toBe('sent')
	expect(await readDailyEmailSendCounter(userId)).toBe(1)
})

test('sendOutboundEmail caps NULL-plan users at the global daily backstop', async () => {
	await ensureEmailTestSchema(env.APP_DB)

	const email = `legacy-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedVerifiedAccount({ email, plan: null })
	for (
		let index = 0;
		index < nullPlanEmailFallbackLimits.email_sends_per_day - 1;
		index += 1
	) {
		await incrementDailyEntitlementCounter({
			db: env.APP_DB,
			userId,
			resource: 'email_sends_per_day',
		})
	}
	// One send left under the backstop succeeds...
	const result = await sendSelfNotification({ userId, accountEmail: email })
	expect(result.status).toBe('sent')
	expect(await readDailyEmailSendCounter(userId)).toBe(
		nullPlanEmailFallbackLimits.email_sends_per_day,
	)

	// ...and the next one is denied: plan-less users are not unlimited.
	const error = await sendSelfNotification({
		userId,
		accountEmail: email,
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
		plan: null,
		limit: nullPlanEmailFallbackLimits.email_sends_per_day,
		current: nullPlanEmailFallbackLimits.email_sends_per_day,
	})
	expect(await readDailyEmailSendCounter(userId)).toBe(
		nullPlanEmailFallbackLimits.email_sends_per_day,
	)
})
