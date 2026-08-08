import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { emailRawMimeKey } from './blob-keys.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { type Mailbox } from './mailbox-do.ts'
import { stubFor } from './mailbox-test-helpers.ts'
import { getOutboundProviderIndexRow } from './outbound-provider-index.ts'
import { getEmailAttachmentById } from './service.ts'
import {
	maxOutboundEmailAttachmentTotalBytes,
	sendOutboundEmail,
} from './outbound.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { maxPlanEmailLimits, planLimits } from '#universal/plans.ts'
import { UserMeter } from '#worker/entitlements/user-meter-do.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const cloudflareEmailApi =
	'https://api.cloudflare.test/client/v4/accounts/account-123/email/sending/send'

const platformBaseUrl = 'https://kody.example.com'
// User mail lives on the inbox. subdomain derived from APP_BASE_URL.
const platformDomain = 'inbox.kody.example.com'

function captureD1Sql(db: D1Database) {
	const sql: Array<string> = []
	return {
		sql,
		db: new Proxy(db, {
			get(target, property, receiver) {
				if (property === 'prepare') {
					return (statement: string) => {
						sql.push(statement)
						return target.prepare(statement)
					}
				}
				if (property === 'exec') {
					return (statement: string) => {
						sql.push(statement)
						return target.exec(statement)
					}
				}
				const value = Reflect.get(target, property, receiver)
				return typeof value === 'function' ? value.bind(target) : value
			},
		}),
	}
}

async function writeInboundMailboxMessage(input: {
	userId: string
	fromAddress: string
	envelopeFrom: string
	toAddresses: Array<string>
	subject: string
	messageIdHeader: string
	receivedAt: string
}) {
	const id = crypto.randomUUID()
	const message = {
		id,
		direction: 'inbound' as const,
		inboxId: null,
		threadId: null,
		senderIdentityId: null,
		fromAddress: input.fromAddress,
		envelopeFrom: input.envelopeFrom,
		toAddresses: input.toAddresses,
		ccAddresses: [],
		bccAddresses: [],
		replyToAddresses: [],
		subject: input.subject,
		messageIdHeader: input.messageIdHeader,
		inReplyToHeader: null,
		references: [],
		headers: {},
		authResults: null,
		textBody: null,
		htmlBody: null,
		rawMimeKey: emailRawMimeKey(input.userId, id),
		rawSize: 0,
		processingStatus: 'stored' as const,
		classification: 'accepted' as const,
		classificationReason: null,
		providerMessageId: null,
		deliveryStatus: null,
		deliveryStatusAt: null,
		error: null,
		receivedAt: input.receivedAt,
		sentAt: null,
		createdAt: input.receivedAt,
		updatedAt: input.receivedAt,
	}
	await mailboxRpc({ env, userId: input.userId }).upsertMessageGraph({
		ownerId: input.userId,
		message,
		attachments: [],
	})
	return message
}

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
	plan?: 'pro' | 'max'
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
			input.plan ?? 'max',
			stableUserId,
		)
		.run()
	return { username, from: `${username}@${platformDomain}` }
}

async function readDailyEmailSendCounter(userId: string) {
	const result = await userMeterRpc({ env, userId }).read({
		resource: 'email_sends_per_day',
		day: utcDayKey(),
	})
	return result.outcome === 'ready' ? result.count : 0
}

async function seedDailyEmailSendCounter(userId: string, count: number) {
	const day = utcDayKey()
	const updatedAt = new Date().toISOString()
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(userId)),
	)
	await runInDurableObject(stub, async (instance: UserMeter, state) => {
		expect(instance).toBeInstanceOf(UserMeter)
		await instance.read({ resource: 'email_sends_per_day', day })
		state.storage.sql.exec(
			`INSERT INTO daily_counters (resource, day, count, revision, updated_at)
			VALUES (?, ?, ?, 1, ?)
			ON CONFLICT(resource, day) DO UPDATE SET
				count = excluded.count,
				revision = excluded.revision,
				updated_at = excluded.updated_at`,
			'email_sends_per_day',
			day,
			count,
			updatedAt,
		)
	})
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
	const capturedD1 = captureD1Sql(env.APP_DB)
	const sendEnv = {
		...env,
		APP_DB: capturedD1.db,
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
	const stored = await mailboxRpc({ env, userId }).getMessage({
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
	// Outbound sends store parsed bodies only: nothing written to EMAIL_BLOBS.
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
	const listed = await mailboxRpc({ env, userId }).listMessages({
		direction: 'outbound',
		limit: 5,
	})
	expect(listed.messages.map((message) => message.id)).toContain(
		result.message.id,
	)
	expect(capturedD1.sql.join('\n')).not.toMatch(
		/\bemail_(?:threads|messages|attachments|delivery_events)\b/,
	)
}, 30_000)

test('provider acceptance survives D1 index outage and the Mailbox alarm repairs without resend', async () => {
	silenceIncidentalRuntimeWarnings()
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `repair-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	await seedVerifiedAccount({ email: accountEmail })
	const providerMessageId = `provider-repair-${crypto.randomUUID()}`
	let sendCount = 0
	const unavailableIndexDb = new Proxy(env.APP_DB, {
		get(target, property, receiver) {
			if (property !== 'prepare') {
				const value = Reflect.get(target, property, receiver)
				return typeof value === 'function' ? value.bind(target) : value
			}
			return (sql: string) => {
				const statement = target.prepare(sql)
				if (!sql.includes('INSERT INTO email_outbound_provider_index')) {
					return statement
				}
				return new Proxy(statement, {
					get(statementTarget, statementProperty) {
						if (statementProperty !== 'bind') {
							const value = Reflect.get(statementTarget, statementProperty)
							return typeof value === 'function'
								? value.bind(statementTarget)
								: value
						}
						return (...values: Array<unknown>) => {
							const bound = statementTarget.bind(...values)
							return new Proxy(bound, {
								get(boundTarget, boundProperty) {
									if (boundProperty === 'run') {
										return async () => {
											throw new Error('injected provider-index D1 outage')
										}
									}
									const value = Reflect.get(boundTarget, boundProperty)
									return typeof value === 'function'
										? value.bind(boundTarget)
										: value
								},
							})
						}
					},
				})
			}
		},
	})
	const result = await sendOutboundEmail({
		env: {
			...env,
			APP_DB: unavailableIndexDb,
			APP_BASE_URL: platformBaseUrl,
			EMAIL: {
				async send() {
					sendCount += 1
					return { messageId: providerMessageId }
				},
			},
		},
		userId,
		accountEmail,
		recipientPolicy: 'self',
		subject: 'Repair after acceptance',
		text: 'Body',
	})

	expect(result.status).toBe('sent')
	expect(sendCount).toBe(1)
	await expect(
		getOutboundProviderIndexRow({ db: env.APP_DB, providerMessageId }),
	).resolves.toBeNull()
	const mailbox = mailboxRpc({ env, userId })
	await expect(
		mailbox.getOutboundProviderIndexRepairStatus({ ownerId: userId }),
	).resolves.toMatchObject({ pendingCount: 1 })
	await runInDurableObject(
		stubFor(userId),
		async (instance: Mailbox, state) => {
			state.storage.sql.exec(
				`UPDATE email_outbound_provider_index_repairs
			SET retry_at = ?`,
				'2026-08-03T00:00:00.000Z',
			)
			await instance.alarm()
		},
	)

	expect(sendCount).toBe(1)
	await expect(
		getOutboundProviderIndexRow({ db: env.APP_DB, providerMessageId }),
	).resolves.toMatchObject({ userId, messageId: result.message.id })
	await expect(
		mailbox.getOutboundProviderIndexRepairStatus({ ownerId: userId }),
	).resolves.toMatchObject({ pendingCount: 0 })
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-outbound-provider-index-persistence-failed',
		expect.objectContaining({
			messageId: result.message.id,
			providerMessageId,
			error: expect.any(Error),
		}),
	)
}, 30_000)

test('sendOutboundEmail rejects suspended accounts', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `suspended-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	await seedVerifiedAccount({ email: accountEmail })
	await env.APP_DB.prepare(
		`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`,
	)
		.bind(new Date().toISOString(), userId)
		.run()

	await expect(
		sendOutboundEmail({
			env: createBindingSendEnv(),
			userId,
			accountEmail,
			recipientPolicy: 'self',
			subject: 'Blocked while suspended',
			text: 'Body',
		}),
	).rejects.toThrow('This account is suspended')
})

test('sendOutboundEmail rejects non-self recipients under the self policy', async () => {
	// Usage recording degrades with a warn when the usage_rollups table is
	// not part of this test's schema; that is incidental to the policy.
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const accountEmail = `account-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(accountEmail)
	await seedVerifiedAccount({ email: accountEmail })

	const nonSelfError = await sendOutboundEmail({
		env: createBindingSendEnv(),
		userId,
		accountEmail,
		recipientPolicy: 'self',
		to: 'someone-else@example.net',
		subject: 'Blocked',
		text: 'Body',
	}).catch((caught: unknown) => caught)
	// Agent mistakes (third-party `to`) must stay off Sentry as McpCallerError.
	expect(nonSelfError).toBeInstanceOf(McpCallerError)
	expect(nonSelfError).toMatchObject({
		message: expect.stringContaining(
			`email_send only delivers to your own account email (${accountEmail})`,
		),
	})
	// Malformed explicit recipients are rejected instead of silently dropped
	// (a dropped value would fall back to the account email).
	const invalidError = await sendOutboundEmail({
		env: createBindingSendEnv(),
		userId,
		accountEmail,
		recipientPolicy: 'self',
		to: 'not-an-email',
		subject: 'Blocked',
		text: 'Body',
	}).catch((caught: unknown) => caught)
	expect(invalidError).toBeInstanceOf(McpCallerError)
	expect(invalidError).toMatchObject({
		message: 'Invalid recipient email address: not-an-email',
	})
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
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(username) DO UPDATE SET
				email = excluded.email,
				email_verified_at = excluded.email_verified_at,
				stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id),
				plan = excluded.plan`,
	)
		.bind(
			'kody',
			reservedEmail,
			'test-password-hash',
			new Date().toISOString(),
			reservedUserId,
			'max',
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
	const inbound = await writeInboundMailboxMessage({
		userId,
		fromAddress: 'recipient@example.com',
		envelopeFrom: 'recipient@example.com',
		toAddresses: [accountEmail],
		subject: 'Hello from Kody',
		messageIdHeader: '<inbound-root@example.com>',
		receivedAt: new Date().toISOString(),
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
	const stored = await mailboxRpc({ env, userId }).getMessage({
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
	const inbound = await writeInboundMailboxMessage({
		userId,
		fromAddress: 'recipient@example.com',
		envelopeFrom: 'recipient@example.com',
		toAddresses: [accountEmail],
		subject: 'Needs a file',
		messageIdHeader: '<inbound-attach@example.com>',
		receivedAt: new Date().toISOString(),
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
	const stored = await mailboxRpc({ env, userId }).listAttachmentsForMessage({
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
		env,
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
	await mailboxRpc({ env, userId }).deleteMessageWithBlobs({
		ownerId: userId,
		messageId: result.message.id,
	})
	expect(await env.EMAIL_BLOBS.get(storageKey!)).toBeNull()
	expect(
		await mailboxRpc({ env, userId }).listAttachmentsForMessage({
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

	// Attachments put the message under the per-message email_message_bytes
	// cap that body-only sends are not subject to.
	const oversize = new Uint8Array(maxPlanEmailLimits.email_message_bytes + 1)
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
		await mailboxRpc({ env, userId }).listMessages({
			direction: 'outbound',
			limit: 5,
		}),
	).toMatchObject({ messages: [] })
}, 30_000)

test('sendOutboundEmail enforces email_sends_per_day for plan users at the limit', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `planned-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.pro.maxEmailSendsPerDay
	if (limit === null) throw new Error('Expected a numeric pro email limit.')
	await seedVerifiedAccount({ email, plan: 'pro' })
	await seedDailyEmailSendCounter(userId, limit)

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
}, 30_000)

test('sendOutboundEmail binds plan limits even when the caller context has no account email', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `contextless-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.pro.maxEmailSendsPerDay
	if (limit === null) throw new Error('Expected a numeric pro email limit.')
	await seedVerifiedAccount({ email, plan: 'pro' })
	await seedDailyEmailSendCounter(userId, limit)

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
}, 30_000)

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
}, 30_000)

test('sendOutboundEmail refunds the daily counter when mailbox storage fails before a copy is stored', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `refund-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.pro.maxEmailSendsPerDay
	if (limit === null) throw new Error('Expected a numeric pro email limit.')
	await seedVerifiedAccount({ email, plan: 'pro' })
	await seedDailyEmailSendCounter(userId, limit - 1)

	await expect(
		sendOutboundEmail({
			env: createBindingSendEnv(),
			userId,
			accountEmail: email,
			recipientPolicy: 'self',
			subject: 'Hello from Kody',
			text: 'Body',
			threadId: 'missing-thread',
		}),
	).rejects.toThrow('Email thread was not found: missing-thread')

	expect(await readDailyEmailSendCounter(userId)).toBe(limit - 1)
	expect(
		await mailboxRpc({ env, userId }).listMessages({
			direction: 'outbound',
			limit: 5,
		}),
	).toMatchObject({ messages: [] })

	// Without the refund, this send would hit the plan limit.
	const result = await sendSelfNotification({
		userId,
		accountEmail: email,
	})
	expect(result.status).toBe('sent')
	expect(await readDailyEmailSendCounter(userId)).toBe(limit)
}, 30_000)

test('sendOutboundEmail caps max-plan users at the email daily backstop', async () => {
	await ensureEmailTestSchema(env.APP_DB)

	const email = `max-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedVerifiedAccount({ email, plan: 'max' })
	await seedDailyEmailSendCounter(
		userId,
		maxPlanEmailLimits.email_sends_per_day - 1,
	)
	// One send left under the backstop succeeds...
	const result = await sendSelfNotification({ userId, accountEmail: email })
	expect(result.status).toBe('sent')
	expect(await readDailyEmailSendCounter(userId)).toBe(
		maxPlanEmailLimits.email_sends_per_day,
	)

	// ...and the next one is denied: max is not uncapped for email.
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
		plan: 'max',
		limit: maxPlanEmailLimits.email_sends_per_day,
		current: maxPlanEmailLimits.email_sends_per_day,
	})
	expect(await readDailyEmailSendCounter(userId)).toBe(
		maxPlanEmailLimits.email_sends_per_day,
	)
}, 30_000)
