import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { isAccountEmailVerified } from '#app/email-verification.ts'
import { normalizeEmail } from '#app/normalize-email.ts'
import { nullPlanEmailFallbackLimits } from '#worker/entitlements/plans.ts'
import { consumeDailyEntitlement } from '#worker/entitlements/service.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import { normalizeEmailAddress } from './address.ts'
import { resolveUserPlatformSender } from './platform-address.ts'
import {
	createEmailThread,
	ensurePlatformSenderIdentity,
	getEmailMessageById,
	getEmailMessageByMessageIdHeader,
	insertEmailMessage,
	insertEmailDeliveryEvent,
	updateEmailMessageDelivery,
} from './repo.ts'
import { type EmailMessageRecord, type EmailProcessingStatus } from './types.ts'

type SendEmailEnv = Pick<
	Env,
	| 'APP_DB'
	| 'EMAIL'
	| 'USAGE_EVENTS'
	| 'APP_BASE_URL'
	| 'CLOUDFLARE_ACCOUNT_ID'
	| 'CLOUDFLARE_API_BASE_URL'
	| 'CLOUDFLARE_API_TOKEN'
>

export type EmailSendInput = {
	env: SendEmailEnv
	userId: string
	/**
	 * Acting user's account email (not the message from/to) when the caller
	 * context has one. Package runtime contexts may pass an empty string;
	 * the account is then resolved from the stable userId so the
	 * verified-account gate and entitlement plan lookup still bind.
	 */
	accountEmail: string
	subject: string
	text?: string | null
	html?: string | null
	replyTo?: string | null
	inReplyToHeader?: string | null
	references?: Array<string>
	threadId?: string | null
	inboxId?: string | null
} & (
	| {
			/**
			 * Notify-self policy (email_send): only the acting user's own
			 * account email may be addressed — never an outreach channel.
			 */
			recipientPolicy: 'self'
			/** Defaults to the acting user's account email. */
			to?: string | Array<string> | null
	  }
	| {
			/**
			 * Reply policy (email_reply): the recipient is derived from the
			 * stored inbound message; callers never supply it.
			 */
			recipientPolicy: 'reply'
			replyToMessageId: string
	  }
)

export type EmailSendResult = {
	message: EmailMessageRecord
	providerMessageId: string | null
	status: EmailProcessingStatus
	error: string | null
}

function resolveSelfRecipients(input: {
	to: string | Array<string> | null | undefined
	accountEmail: string
}) {
	const accountEmail = normalizeEmail(input.accountEmail)
	const values =
		input.to == null ? [] : Array.isArray(input.to) ? input.to : [input.to]
	const normalized = values.map((value) => {
		const address = normalizeEmailAddress(value)
		if (!address) {
			throw new Error(`Invalid recipient email address: ${value}`)
		}
		return address
	})
	const disallowed = normalized.filter((value) => value !== accountEmail)
	if (disallowed.length > 0) {
		throw new Error(
			`email_send only delivers to your own account email (${accountEmail}). Use email_reply to answer stored inbound messages.`,
		)
	}
	return [accountEmail]
}

function deriveReplyRecipient(original: EmailMessageRecord) {
	const candidates = [
		...original.replyToAddresses,
		original.fromAddress,
		original.envelopeFrom,
	]
	for (const candidate of candidates) {
		if (typeof candidate !== 'string') continue
		const address = normalizeEmailAddress(candidate)
		if (address) return address
	}
	throw new Error('Original message has no reply address.')
}

function buildStoredHeaders(input: {
	messageId: string
	inReplyTo?: string | null
	references?: Array<string>
}) {
	const headers: Record<string, string> = {
		'Message-ID': input.messageId,
		'X-Kody-Email-Message-Id': input.messageId,
	}
	if (input.inReplyTo) headers['In-Reply-To'] = input.inReplyTo
	if (input.references && input.references.length > 0) {
		headers['References'] = input.references.join(' ')
	}
	return headers
}

const cloudflareSendAllowedHeaders = new Set(['in-reply-to', 'references'])

function buildProviderHeaders(headers: Record<string, string>) {
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) =>
			cloudflareSendAllowedHeaders.has(name.toLowerCase()),
		),
	)
}

async function requireStoredEmailMessage(input: {
	env: SendEmailEnv
	userId: string
	messageId: string
}) {
	const stored = await getEmailMessageById({
		db: input.env.APP_DB,
		userId: input.userId,
		messageId: input.messageId,
	})
	if (!stored) {
		throw new Error(
			`Email message disappeared after delivery update: ${input.messageId}`,
		)
	}
	return stored
}

async function sendViaBinding(input: {
	env: SendEmailEnv
	from: string
	to: Array<string>
	subject: string
	text?: string | null
	html?: string | null
	replyTo?: string | null
	headers: Record<string, string>
}) {
	const binding = input.env.EMAIL
	if (!binding) return { sent: false, messageId: null }
	const result = await binding.send({
		from: input.from,
		to: input.to.length === 1 ? input.to[0]! : input.to,
		subject: input.subject,
		...(input.replyTo ? { replyTo: input.replyTo } : {}),
		headers: input.headers,
		...(input.text ? { text: input.text } : {}),
		...(input.html ? { html: input.html } : {}),
	})
	return { sent: true, messageId: result.messageId ?? null }
}

async function sendViaRestFallback(input: {
	env: SendEmailEnv
	from: string
	to: Array<string>
	subject: string
	text?: string | null
	html?: string | null
	replyTo?: string | null
	headers: Record<string, string>
}) {
	const html = input.html ?? input.text
	if (!html) {
		throw new Error('Email text or HTML body is required.')
	}
	const result = await sendCloudflareEmail(
		{
			accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
			apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
			apiToken: input.env.CLOUDFLARE_API_TOKEN,
		},
		{
			from: input.from,
			to: input.to.length === 1 ? input.to[0]! : input.to,
			subject: input.subject,
			html,
			text: input.text ?? undefined,
			replyTo: input.replyTo ?? undefined,
			headers:
				Object.keys(input.headers).length > 0 ? input.headers : undefined,
		},
	)
	if (!result.ok) {
		throw new Error(result.error ?? 'Cloudflare email send was skipped.')
	}
	return result.messageId ?? null
}

function outboundEmailContentBytes(
	text: string | null,
	html: string | null,
): number | undefined {
	if (!text && !html) return undefined
	let bytes = 0
	if (text) bytes += new TextEncoder().encode(text).byteLength
	if (html) bytes += new TextEncoder().encode(html).byteLength
	return bytes
}

export async function sendOutboundEmail(
	input: EmailSendInput,
): Promise<EmailSendResult> {
	// The from address is always platform-assigned: {username}@<platform
	// domain>. There is no self-service sender verification. The resolved
	// account email (recovered from the stable userId when the caller
	// context carried none, e.g. package subscription handlers) backs the
	// verified-account gate and the entitlement plan lookup so plan limits
	// can never be bypassed by an empty context email.
	const sender = await resolveUserPlatformSender({
		db: input.env.APP_DB,
		env: input.env,
		accountEmail: input.accountEmail,
		userId: input.userId,
	})
	const from = sender.from
	const accountEmailVerified = await isAccountEmailVerified({
		db: input.env.APP_DB,
		email: sender.accountEmail,
		stableUserId: input.userId,
	})
	if (!accountEmailVerified) {
		throw new Error('Account email must be verified before sending email.')
	}
	// Sends reference the platform-provisioned sender identity. It is
	// normally created alongside the default inbox at signup; ensuring it
	// here also covers accounts provisioned before the identity existed.
	const senderIdentity = await ensurePlatformSenderIdentity({
		db: input.env.APP_DB,
		userId: input.userId,
		email: sender.from,
		domain: sender.domain,
	})

	let original: EmailMessageRecord | null = null
	let to: Array<string>
	if (input.recipientPolicy === 'reply') {
		// The recipient is derived from the stored inbound message — callers
		// can never turn a reply into outreach.
		const replyOriginal = await getEmailMessageById({
			db: input.env.APP_DB,
			userId: input.userId,
			messageId: input.replyToMessageId,
		})
		if (!replyOriginal || replyOriginal.direction !== 'inbound') {
			throw new Error('Replying requires a stored inbound message.')
		}
		original = replyOriginal
		to = [deriveReplyRecipient(replyOriginal)]
	} else {
		if (input.inReplyToHeader) {
			original = await getEmailMessageByMessageIdHeader({
				db: input.env.APP_DB,
				userId: input.userId,
				messageIdHeader: input.inReplyToHeader,
			})
			if (!original) {
				throw new Error(
					`Cannot reply because original message ${input.inReplyToHeader} was not found.`,
				)
			}
		}
		to = resolveSelfRecipients({
			to: input.to,
			accountEmail: sender.accountEmail,
		})
	}
	const subject = input.subject.trim()
	if (!subject) throw new Error('Email subject is required.')
	const text = input.text?.trim() || null
	const html = input.html?.trim() || null
	if (!text && !html) throw new Error('Email text or HTML body is required.')

	// Atomic check-and-increment: the counter tracks attempts for every user
	// and denies the send when a plan's daily limit is reached. Users
	// without a plan are capped by the global daily backstop instead of
	// sending unlimited mail.
	await consumeDailyEntitlement({
		db: input.env.APP_DB,
		userId: input.userId,
		email: sender.accountEmail,
		resource: 'email_sends_per_day',
		fallbackLimit: nullPlanEmailFallbackLimits.email_sends_per_day,
	})

	const existingThreadId = original?.threadId ?? input.threadId ?? null
	const thread = existingThreadId
		? null
		: await createEmailThread({
				db: input.env.APP_DB,
				userId: input.userId,
				inboxId: original?.inboxId ?? input.inboxId ?? null,
				subjectNormalized: subject.toLowerCase(),
				rootMessageIdHeader: input.inReplyToHeader ?? null,
				lastMessageAt: new Date().toISOString(),
			})
	const threadId = existingThreadId ?? thread?.id ?? null
	const messageIdHeader = `<${crypto.randomUUID()}@kody.local>`
	const storedHeaders = buildStoredHeaders({
		messageId: messageIdHeader,
		inReplyTo: input.inReplyToHeader ?? null,
		references: input.references ?? [],
	})
	const providerHeaders = buildProviderHeaders(storedHeaders)
	const message = await insertEmailMessage({
		db: input.env.APP_DB,
		message: {
			direction: 'outbound',
			userId: input.userId,
			inboxId: original?.inboxId ?? input.inboxId ?? null,
			threadId,
			senderIdentityId: senderIdentity.id,
			fromAddress: from,
			envelopeFrom: from,
			toAddresses: to,
			ccAddresses: [],
			bccAddresses: [],
			replyToAddresses: input.replyTo
				? [normalizeEmailAddress(input.replyTo)].filter(
						(value): value is string => typeof value === 'string',
					)
				: [],
			subject,
			messageIdHeader,
			inReplyToHeader: input.inReplyToHeader ?? null,
			references: input.references ?? [],
			headers: storedHeaders,
			authResults: null,
			textBody: text,
			htmlBody: html,
			rawMime: null,
			rawSize: null,
			processingStatus: 'stored',
			providerMessageId: null,
			error: null,
			receivedAt: null,
			sentAt: null,
		},
	})
	await insertEmailDeliveryEvent({
		db: input.env.APP_DB,
		messageId: message.id,
		userId: input.userId,
		inboxId: null,
		eventType: 'send_requested',
		provider: 'cloudflare-email',
		providerMessageId: null,
		detail: { to, from, subject },
	})

	const messageContentBytes = outboundEmailContentBytes(text, html)
	const sendStartedAtMs = Date.now()
	let sendOutcome: 'success' | 'error' = 'success'
	try {
		const bindingResult = await sendViaBinding({
			env: input.env,
			from,
			to,
			subject,
			text,
			html,
			replyTo: input.replyTo
				? (normalizeEmailAddress(input.replyTo) ?? undefined)
				: undefined,
			headers: providerHeaders,
		})
		const providerMessageId = bindingResult.sent
			? bindingResult.messageId
			: await sendViaRestFallback({
					env: input.env,
					from,
					to,
					subject,
					text,
					html,
					replyTo: input.replyTo
						? (normalizeEmailAddress(input.replyTo) ?? undefined)
						: undefined,
					headers: providerHeaders,
				})
		await updateEmailMessageDelivery({
			db: input.env.APP_DB,
			messageId: message.id,
			status: 'sent',
			providerMessageId,
			error: null,
			sentAt: new Date().toISOString(),
		})
		await insertEmailDeliveryEvent({
			db: input.env.APP_DB,
			messageId: message.id,
			userId: input.userId,
			inboxId: null,
			eventType: 'sent',
			provider: 'cloudflare-email',
			providerMessageId,
			detail: { providerMessageId },
		})
		return {
			message: await requireStoredEmailMessage({
				env: input.env,
				userId: input.userId,
				messageId: message.id,
			}),
			providerMessageId,
			status: 'sent',
			error: null,
		}
	} catch (error) {
		sendOutcome = 'error'
		const messageText = error instanceof Error ? error.message : String(error)
		await updateEmailMessageDelivery({
			db: input.env.APP_DB,
			messageId: message.id,
			status: 'failed',
			providerMessageId: null,
			error: messageText,
			sentAt: null,
		}).catch((updateError) => {
			console.warn('email-delivery-failure-status-update-failed', updateError)
		})
		await insertEmailDeliveryEvent({
			db: input.env.APP_DB,
			messageId: message.id,
			userId: input.userId,
			inboxId: null,
			eventType: 'failed',
			provider: 'cloudflare-email',
			providerMessageId: null,
			detail: { error: messageText },
		}).catch((eventError) => {
			console.warn('email-delivery-failure-event-insert-failed', eventError)
		})
		return {
			message:
				(await getEmailMessageById({
					db: input.env.APP_DB,
					userId: input.userId,
					messageId: message.id,
				})) ?? message,
			providerMessageId: null,
			status: 'failed',
			error: messageText,
		}
	} finally {
		if (input.userId) {
			await recordUsage(input.env, {
				userId: input.userId,
				eventType: 'email_send',
				entityId: message.id,
				bytes: messageContentBytes,
				durationMs: Date.now() - sendStartedAtMs,
				outcome: sendOutcome,
			})
		}
	}
}
