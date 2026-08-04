import { base64ToBytes } from '@kody-internal/shared/base64.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	accountSuspendedMessage,
	getAccountRestrictionsByStableUserId,
} from '#app/account-suspension.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { isAccountEmailVerified } from '#worker/identity/email-verification-state.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	assertWithinEntitlement,
	consumeDailyEntitlement,
	estimateEntitlementStorageEntryBytes,
} from '#worker/entitlements/service.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import { normalizeEmailAddress } from './address.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import { mailboxMessageToEmailMessageRecord } from './mailbox-record-mappers.ts'
import {
	type MailboxAttachmentInput,
	type MailboxDeliveryEventInput,
	type MailboxMessageInput,
	type MailboxThreadInput,
} from './mailbox-types.ts'
import { emailOutboundPausedMessage } from './outbound-abuse.ts'
import {
	emailOutboundProviderCloudflare,
	upsertOutboundProviderIndexRow,
} from './outbound-provider-index.ts'
import { resolveUserPlatformSender } from './platform-address.ts'
import { assertUserEmailGraphAuthority } from './user-email-graph-authority.ts'
import {
	recordEmailReportingEvent,
	type EmailReportingEnv,
} from './reporting-events.ts'
import { reserveEmailStorageBytes } from './storage-reservation.ts'
import {
	emailAttachmentBlobKey,
	ensurePlatformSenderIdentity,
} from './service.ts'
import { type EmailMessageRecord, type EmailProcessingStatus } from './types.ts'

type SendEmailEnv = Pick<
	Env,
	| 'APP_DB'
	| 'EMAIL'
	| 'EMAIL_BLOBS'
	| 'USAGE_EVENTS'
	| 'APP_BASE_URL'
	| 'USER_EMAIL_DOMAIN'
	| 'CLOUDFLARE_ACCOUNT_ID'
	| 'CLOUDFLARE_API_BASE_URL'
	| 'CLOUDFLARE_API_TOKEN'
	| 'USER_METER'
	| 'MAILBOX'
	| 'EMAIL_EVENTS'
> &
	EmailReportingEnv &
	MailboxEnv

/**
 * Ceiling on the number of files per outbound message. Total size is
 * governed separately by the plan's email_message_bytes limit (and the
 * provider's own 5 MiB hard cap far above it).
 */
export const maxOutboundEmailAttachments = 10

/**
 * Hard ceiling on combined decoded attachment bytes, matching the
 * provider's 5 MiB message cap. Enforced from base64 string lengths
 * before any decoding so oversized inputs never allocate buffers;
 * plan-level email_message_bytes still applies afterwards.
 */
export const maxOutboundEmailAttachmentTotalBytes = 5 * 1024 * 1024

export type OutboundEmailAttachmentInput = {
	filename: string
	contentType: string
	/** Base64-encoded attachment bytes. */
	contentBase64: string
}

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
	attachments?: Array<OutboundEmailAttachmentInput>
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

/**
 * Provider accepted the send, but Mailbox terminal persistence failed after
 * bounded retries. The message must not be marked `failed` or resent.
 */
export class OutboundEmailPersistenceError extends Error {
	override name = 'OutboundEmailPersistenceError'
	readonly messageId: string
	readonly providerMessageId: string | null
	constructor(input: {
		messageId: string
		providerMessageId: string | null
		cause?: unknown
	}) {
		super(
			`Provider accepted outbound email ${input.messageId} (providerMessageId=${input.providerMessageId ?? 'null'}) but terminal persistence failed after retries. Do not resend; repair Mailbox/index state for this message.`,
			{ cause: input.cause },
		)
		this.messageId = input.messageId
		this.providerMessageId = input.providerMessageId
	}
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
			// Caller-supplied address that does not parse — keep it off Sentry.
			throw new McpCallerError(`Invalid recipient email address: ${value}`)
		}
		return address
	})
	const disallowed = normalized.filter((value) => value !== accountEmail)
	if (disallowed.length > 0) {
		// email_send is notify-self only; agents often pass a third-party
		// address by mistake. That is a routine caller correction (use
		// email_reply), not a platform defect — keep it off Sentry.
		throw new McpCallerError(
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

type PreparedOutboundAttachment = {
	filename: string
	contentType: string
	bytes: Uint8Array
	contentBase64: string
}

function prepareOutboundAttachments(
	attachments: Array<OutboundEmailAttachmentInput> | undefined,
): Array<PreparedOutboundAttachment> {
	if (!attachments || attachments.length === 0) return []
	if (attachments.length > maxOutboundEmailAttachments) {
		throw new Error(
			`Outbound email supports at most ${maxOutboundEmailAttachments} attachments.`,
		)
	}
	// Base64 encodes 3 bytes per 4 characters, so the string length bounds
	// the decoded size without allocating anything.
	const estimatedTotalBytes = attachments.reduce(
		(total, attachment) =>
			total + Math.floor((attachment.contentBase64.trim().length * 3) / 4),
		0,
	)
	if (estimatedTotalBytes > maxOutboundEmailAttachmentTotalBytes) {
		throw new Error(
			`Outbound email attachments exceed the ${Math.floor(maxOutboundEmailAttachmentTotalBytes / (1024 * 1024))} MiB combined limit.`,
		)
	}
	return attachments.map((attachment) => {
		const filename = attachment.filename.trim()
		if (!filename) throw new Error('Attachment filename is required.')
		const contentType = attachment.contentType.trim()
		if (!contentType) {
			throw new Error(`Attachment content type is required: ${filename}`)
		}
		const contentBase64 = attachment.contentBase64.trim()
		let bytes: Uint8Array
		try {
			bytes = base64ToBytes(contentBase64)
		} catch {
			throw new Error(`Attachment content must be valid base64: ${filename}`)
		}
		if (bytes.byteLength === 0) {
			throw new Error(`Attachment content is empty: ${filename}`)
		}
		return { filename, contentType, bytes, contentBase64 }
	})
}

/**
 * Persist outbound attachment bytes to R2 and prepare Mailbox metadata.
 * A failed blob put degrades that attachment to metadata-only
 * (storage_kind 'unavailable') rather than blocking the send — the provider
 * still receives the in-memory bytes.
 */
async function storeOutboundAttachments(input: {
	blobs: R2Bucket
	userId: string
	messageId: string
	attachments: Array<PreparedOutboundAttachment>
	now: string
}): Promise<Array<MailboxAttachmentInput>> {
	const rows: Array<MailboxAttachmentInput> = []
	for (const attachment of input.attachments) {
		const attachmentId = crypto.randomUUID()
		const storageKey = emailAttachmentBlobKey(
			input.userId,
			input.messageId,
			attachmentId,
		)
		let stored = false
		try {
			await input.blobs.put(storageKey, attachment.bytes, {
				httpMetadata: { contentType: attachment.contentType },
			})
			stored = true
		} catch (error) {
			console.warn(
				'email-outbound-attachment-blob-put-failed',
				storageKey,
				error,
			)
		}
		rows.push({
			id: attachmentId,
			messageId: input.messageId,
			filename: attachment.filename,
			contentType: attachment.contentType,
			contentId: null,
			disposition: 'attachment',
			size: attachment.bytes.byteLength,
			storageKind: stored ? 'external' : 'unavailable',
			storageKey: stored ? storageKey : null,
			createdAt: input.now,
		})
	}
	return rows
}

async function requireStoredEmailMessage(input: {
	env: SendEmailEnv
	userId: string
	messageId: string
}) {
	const stored = await mailboxRpc({
		env: input.env,
		userId: input.userId,
	}).getMessage({ messageId: input.messageId })
	if (!stored) {
		throw new Error(
			`Email message disappeared after delivery update: ${input.messageId}`,
		)
	}
	return mailboxMessageToEmailMessageRecord(stored, input.userId)
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
	attachments: Array<PreparedOutboundAttachment>
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
		...(input.attachments.length > 0
			? {
					// The binding treats string content as raw text, so binary
					// payloads must go through as bytes rather than base64.
					attachments: input.attachments.map((attachment) => ({
						disposition: 'attachment' as const,
						filename: attachment.filename,
						type: attachment.contentType,
						content: attachment.bytes,
					})),
				}
			: {}),
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
	attachments: Array<PreparedOutboundAttachment>
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
			attachments:
				input.attachments.length > 0
					? // The REST API expects base64 string content.
						input.attachments.map((attachment) => ({
							content: attachment.contentBase64,
							filename: attachment.filename,
							type: attachment.contentType,
							disposition: 'attachment' as const,
							// The inferred schema output type requires this key even
							// when undefined; JSON.stringify drops it from the payload.
							contentId: undefined,
						}))
					: undefined,
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
	attachmentBytes = 0,
): number | undefined {
	if (!text && !html && attachmentBytes === 0) return undefined
	let bytes = attachmentBytes
	if (text) bytes += new TextEncoder().encode(text).byteLength
	if (html) bytes += new TextEncoder().encode(html).byteLength
	return bytes
}

function outboundDeliveryEvent(input: {
	id?: string
	messageId: string
	inboxId: string | null
	eventType: MailboxDeliveryEventInput['eventType']
	providerMessageId: string | null
	detail: Record<string, unknown>
	now: string
}): MailboxDeliveryEventInput {
	return {
		id: input.id ?? crypto.randomUUID(),
		messageId: input.messageId,
		inboxId: input.inboxId,
		eventType: input.eventType,
		provider: 'cloudflare-email',
		providerMessageId: input.providerMessageId,
		providerEventId: null,
		detailJson: JSON.stringify(input.detail),
		needsEffectReconcile: false,
		state: null,
		fingerprint: null,
		storageLease: null,
		storageLeaseAt: null,
		cleanupLease: null,
		cleanupLeaseAt: null,
		cleanupRetryAt: null,
		expectedAttachmentCount: null,
		finalizationToken: null,
		reconcileAfter: null,
		dedupeExpiresAt: null,
		usageEffectRecordedAt: null,
		usageEffectSuppressedAt: null,
		usageStartedAt: null,
		usageMonth: null,
		usageBytes: null,
		usageDurationMs: null,
		usageEffectRetryAt: null,
		usageEffectLease: null,
		usageEffectLeaseAt: null,
		subscriptionEffectState: null,
		subscriptionEffectLease: null,
		subscriptionEffectLeaseAt: null,
		subscriptionEffectRetryAt: null,
		subscriptionEffectAttemptCount: null,
		subscriptionEffectDeadLetterAt: null,
		subscriptionEffectLastError: null,
		createdAt: input.now,
		updatedAt: input.now,
	}
}

async function retryMailboxTerminal<T>(
	operation: () => Promise<T>,
): Promise<T> {
	let lastError: unknown
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			return await operation()
		} catch (error) {
			lastError = error
			if (attempt < 2) {
				await new Promise<void>((resolve) =>
					setTimeout(resolve, 50 * 2 ** attempt),
				)
			}
		}
	}
	throw lastError
}

export async function sendOutboundEmail(
	unsafeInput: EmailSendInput,
): Promise<EmailSendResult> {
	if (unsafeInput.userId === systemEmailOwnerId) {
		throw new Error('System outbound email is unsupported.')
	}
	const input: EmailSendInput = {
		...unsafeInput,
		env: {
			...unsafeInput.env,
			APP_DB: unsafeInput.env.APP_DB,
		},
	}
	const write = async (): Promise<EmailSendResult> => {
		await assertUserEmailGraphAuthority({
			db: input.env.APP_DB,
			ownerId: input.userId,
		})
		const mailbox = mailboxRpc({ env: input.env, userId: input.userId })
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
		// Abuse gates: a suspended account cannot send at all, and an
		// account paused by the delivery-event abuse monitor (spam
		// complaints / repeated bounces) stays blocked until an admin
		// clears the pause. Both protect the shared platform sending
		// domain's reputation.
		const restrictions = await getAccountRestrictionsByStableUserId({
			db: input.env.APP_DB,
			stableUserId: input.userId,
		})
		if (restrictions?.suspendedAt) {
			throw new Error(accountSuspendedMessage)
		}
		if (restrictions?.emailOutboundPausedAt) {
			throw new Error(emailOutboundPausedMessage)
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
			const replyOriginalRecord = await mailbox.getMessage({
				messageId: input.replyToMessageId,
			})
			const replyOriginal = replyOriginalRecord
				? mailboxMessageToEmailMessageRecord(replyOriginalRecord, input.userId)
				: null
			if (!replyOriginal || replyOriginal.direction !== 'inbound') {
				throw new Error('Replying requires a stored inbound message.')
			}
			original = replyOriginal
			to = [deriveReplyRecipient(replyOriginal)]
		} else {
			if (input.inReplyToHeader) {
				const originalRecord = await mailbox.getMessageByMessageIdHeader({
					messageIdHeader: input.inReplyToHeader,
				})
				original = originalRecord
					? mailboxMessageToEmailMessageRecord(originalRecord, input.userId)
					: null
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
		const attachments = prepareOutboundAttachments(input.attachments)
		const attachmentBytesTotal = attachments.reduce(
			(total, attachment) => total + attachment.bytes.byteLength,
			0,
		)
		if (attachments.length > 0) {
			// Attachments put outbound mail under the same per-message ceiling
			// as inbound mail. Body-only sends keep their pre-attachment
			// behavior (no per-message cap).
			await assertWithinEntitlement({
				db: input.env.APP_DB,
				userId: input.userId,
				email: sender.accountEmail,
				resource: 'email_message_bytes',
				requested: 0,
				getCurrent: async () =>
					(outboundEmailContentBytes(text, html) ?? 0) + attachmentBytesTotal,
			})
		}
		const messageIdHeader = `<${crypto.randomUUID()}@kody.local>`
		const storedHeaders = buildStoredHeaders({
			messageId: messageIdHeader,
			inReplyTo: input.inReplyToHeader ?? null,
			references: input.references ?? [],
		})
		await reserveEmailStorageBytes({
			db: input.env.APP_DB,
			env: input.env,
			userId: input.userId,
			email: sender.accountEmail,
			requested:
				estimateEntitlementStorageEntryBytes({
					key: messageIdHeader,
					value: {
						from,
						to,
						subject,
						replyTo: input.replyTo,
						text,
						html,
						headers: storedHeaders,
					},
				}) + attachmentBytesTotal,
		})

		// Atomic check-and-increment via UserMeter (sole daily authority).
		await consumeDailyEntitlement({
			db: input.env.APP_DB,
			env: input.env,
			userId: input.userId,
			email: sender.accountEmail,
			resource: 'email_sends_per_day',
		})
		recordEmailReportingEvent(input.env, {
			userId: input.userId,
			eventType: 'email_send',
		})

		const now = new Date().toISOString()
		const inboxId = original?.inboxId ?? input.inboxId ?? null
		const existingThreadId = original?.threadId ?? input.threadId ?? null
		const existingThread = existingThreadId
			? await mailbox.getThread({ threadId: existingThreadId })
			: null
		if (existingThreadId && !existingThread) {
			throw new Error(`Email thread was not found: ${existingThreadId}`)
		}
		const thread: MailboxThreadInput = existingThread
			? {
					...existingThread,
					subjectNormalized: existingThread.subjectNormalized ?? '',
					lastMessageAt:
						existingThread.lastMessageAt > now
							? existingThread.lastMessageAt
							: now,
					updatedAt: now,
				}
			: {
					id: crypto.randomUUID(),
					inboxId,
					subjectNormalized: subject.toLowerCase(),
					rootMessageIdHeader: input.inReplyToHeader ?? null,
					lastMessageAt: now,
					createdAt: now,
					updatedAt: now,
				}
		const messageId = crypto.randomUUID()
		const providerHeaders = buildProviderHeaders(storedHeaders)
		const message: MailboxMessageInput = {
			id: messageId,
			direction: 'outbound',
			inboxId,
			threadId: thread.id,
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
			rawMimeKey: null,
			rawSize: 0,
			processingStatus: 'stored',
			classification: 'accepted',
			classificationReason: null,
			providerMessageId: null,
			deliveryStatus: null,
			deliveryStatusAt: null,
			error: null,
			receivedAt: null,
			sentAt: null,
			createdAt: now,
			updatedAt: now,
		}
		const storedAttachments = await storeOutboundAttachments({
			blobs: input.env.EMAIL_BLOBS,
			userId: input.userId,
			messageId: message.id,
			attachments,
			now,
		})
		try {
			const graph = await mailbox.upsertMessageGraph({
				ownerId: input.userId,
				thread,
				message,
				attachments: storedAttachments,
			})
			if (!graph.accepted) {
				throw new Error('Outbound Mailbox graph rejected the message.')
			}
		} catch (error) {
			await Promise.all(
				storedAttachments
					.filter((attachment) => attachment.storageKey != null)
					.map((attachment) =>
						input.env.EMAIL_BLOBS.delete(attachment.storageKey!).catch(
							(deleteError: unknown) => {
								console.warn(
									'email-outbound-attachment-blob-cleanup-failed',
									attachment.storageKey,
									deleteError,
								)
							},
						),
					),
			)
			throw error
		}
		await mailbox.upsertDeliveryEvent({
			ownerId: input.userId,
			event: outboundDeliveryEvent({
				messageId: message.id,
				inboxId,
				eventType: 'send_requested',
				providerMessageId: null,
				detail: { to, from, subject, attachmentCount: attachments.length },
				now,
			}),
		})

		const messageContentBytes = outboundEmailContentBytes(
			text,
			html,
			attachmentBytesTotal,
		)
		const sendStartedAtMs = Date.now()
		let sendOutcome: 'success' | 'error' = 'success'
		try {
			let acceptedProviderMessageId: string | null
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
					attachments,
				})
				acceptedProviderMessageId = bindingResult.sent
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
							attachments,
						})
			} catch (error) {
				// Provider did not accept the send. Safe to mark failed / clear id.
				sendOutcome = 'error'
				const messageText = getErrorMessage(error)
				const failedAt = new Date().toISOString()
				const failedEvent = outboundDeliveryEvent({
					messageId: message.id,
					inboxId,
					eventType: 'failed',
					providerMessageId: null,
					detail: { error: messageText },
					now: failedAt,
				})
				await retryMailboxTerminal(() =>
					mailbox.commitOutboundTerminal({
						ownerId: input.userId,
						messageId: message.id,
						processingStatus: 'failed',
						providerMessageId: null,
						error: messageText,
						sentAt: null,
						event: failedEvent,
					}),
				)
				return {
					message: await requireStoredEmailMessage({
						env: input.env,
						userId: input.userId,
						messageId: message.id,
					}),
					providerMessageId: null,
					status: 'failed',
					error: messageText,
				}
			}

			// Provider accepted — never re-enter the provider call. Persist the
			// owner Mailbox terminal first.
			const sentAt = new Date().toISOString()
			const sentEvent = outboundDeliveryEvent({
				messageId: message.id,
				inboxId,
				eventType: 'sent',
				providerMessageId: acceptedProviderMessageId,
				detail: {
					providerMessageId: acceptedProviderMessageId,
				},
				now: sentAt,
			})
			try {
				await retryMailboxTerminal(() =>
					mailbox.commitOutboundTerminal({
						ownerId: input.userId,
						messageId: message.id,
						processingStatus: 'sent',
						providerMessageId: acceptedProviderMessageId,
						error: null,
						sentAt,
						event: sentEvent,
						...(acceptedProviderMessageId
							? {
									providerIndexRepair: {
										provider: emailOutboundProviderCloudflare,
										providerMessageId: acceptedProviderMessageId,
										messageId: message.id,
										inboxId,
										createdAt: sentAt,
									},
								}
							: {}),
					}),
				)
			} catch (error) {
				console.warn('email-outbound-terminal-persistence-failed', {
					messageId: message.id,
					providerMessageId: acceptedProviderMessageId,
					error,
				})
				throw new OutboundEmailPersistenceError({
					messageId: message.id,
					providerMessageId: acceptedProviderMessageId,
					cause: error,
				})
			}
			// The operational reverse index is independently idempotent. A failed
			// index write must not turn provider acceptance into a resend signal;
			// the Mailbox alarm retries its durable pending repair.
			if (acceptedProviderMessageId) {
				await runD1WithRetry(() =>
					upsertOutboundProviderIndexRow({
						db: input.env.APP_DB,
						providerMessageId: acceptedProviderMessageId,
						userId: input.userId,
						messageId: message.id,
						inboxId,
						now: sentAt,
					}),
				)
					.then(async () => {
						await mailbox.completeOutboundProviderIndexRepair({
							ownerId: input.userId,
							provider: emailOutboundProviderCloudflare,
							providerMessageId: acceptedProviderMessageId,
						})
					})
					.catch((error: unknown) => {
						console.warn('email-outbound-provider-index-persistence-failed', {
							messageId: message.id,
							providerMessageId: acceptedProviderMessageId,
							error,
						})
					})
			}

			return {
				message: await requireStoredEmailMessage({
					env: input.env,
					userId: input.userId,
					messageId: message.id,
				}),
				providerMessageId: acceptedProviderMessageId,
				status: 'sent',
				error: null,
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
	return input.userId
		? await withAccountWriteLease({
				db: input.env.APP_DB,
				stableUserId: input.userId,
				env: input.env,
				write,
			})
		: await write()
}
