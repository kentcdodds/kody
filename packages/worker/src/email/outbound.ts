import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { normalizeEmailAddress } from './address.ts'
import {
	createEmailThread,
	getEmailMessageById,
	getEmailMessageByMessageIdHeader,
	getVerifiedSenderIdentity,
	insertEmailMessage,
	insertEmailDeliveryEvent,
	updateEmailMessageDelivery,
} from './repo.ts'
import { type EmailMessageRecord, type EmailProcessingStatus } from './types.ts'

type SendEmailEnv = Pick<
	Env,
	| 'APP_DB'
	| 'EMAIL'
	| 'CLOUDFLARE_ACCOUNT_ID'
	| 'CLOUDFLARE_API_BASE_URL'
	| 'CLOUDFLARE_API_TOKEN'
>

export type EmailSendInput = {
	env: SendEmailEnv
	userId: string
	from: string
	to: string | Array<string>
	subject: string
	text?: string | null
	html?: string | null
	replyTo?: string | null
	inReplyToHeader?: string | null
	references?: Array<string>
	threadId?: string | null
	inboxId?: string | null
}

export type EmailSendResult = {
	message: EmailMessageRecord
	providerMessageId: string | null
	status: EmailProcessingStatus
	error: string | null
}

function normalizeRecipientList(to: string | Array<string>) {
	const values = Array.isArray(to) ? to : [to]
	const normalized = values
		.map(normalizeEmailAddress)
		.filter((value): value is string => typeof value === 'string')
	if (normalized.length === 0) {
		throw new Error('At least one recipient email address is required.')
	}
	return Array.from(new Set(normalized))
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
		Object.entries(headers).filter(([name]) => {
			return (
				name.startsWith('X-') ||
				cloudflareSendAllowedHeaders.has(name.toLowerCase())
			)
		}),
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
		to: input.to,
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

export async function sendOutboundEmail(
	input: EmailSendInput,
): Promise<EmailSendResult> {
	const from = normalizeEmailAddress(input.from)
	if (!from) throw new Error('A valid from email address is required.')
	const senderIdentity = await getVerifiedSenderIdentity({
		db: input.env.APP_DB,
		userId: input.userId,
		email: from,
	})
	if (!senderIdentity || senderIdentity.status !== 'verified') {
		throw new Error(`Sender identity is not verified: ${from}`)
	}
	const original = input.inReplyToHeader
		? await getEmailMessageByMessageIdHeader({
				db: input.env.APP_DB,
				userId: input.userId,
				messageIdHeader: input.inReplyToHeader,
			})
		: null
	if (input.inReplyToHeader) {
		if (!original) {
			throw new Error(
				`Cannot reply because original message ${input.inReplyToHeader} was not found.`,
			)
		}
	}

	const to = normalizeRecipientList(input.to)
	const subject = input.subject.trim()
	if (!subject) throw new Error('Email subject is required.')
	const text = input.text?.trim() || null
	const html = input.html?.trim() || null
	if (!text && !html) throw new Error('Email text or HTML body is required.')

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
			policyDecision: 'accepted',
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
	}
}
