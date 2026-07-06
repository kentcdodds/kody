import { isReservedUsername } from '#app/reserved-usernames.ts'
import { findPublicUserIdentityByUsername } from '#app/user-lookup.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import {
	nullPlanEmailFallbackLimits,
	parsePlanName,
	resolveEmailResourceLimit,
} from '#worker/entitlements/plans.ts'
import {
	assertWithinEntitlement,
	consumeDailyEntitlement,
} from '#worker/entitlements/service.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import { normalizeEmailAddress, normalizeSubject } from './address.ts'
import { ensureDefaultEmailInbox } from './default-inbox.ts'
import {
	maxInlineRawMimeBytes,
	parseForwardableEmailMessage,
} from './parser.ts'
import { getPlatformEmailDomain } from './platform-address.ts'
import {
	createEmailThread,
	findEmailThreadForInboundMessage,
	insertEmailDeliveryEvent,
	insertEmailMessageWithAttachments,
	recordBoundedEmailRejectionEvent,
	touchEmailThread,
} from './repo.ts'
import { dispatchInboundEmailSubscriptionEvents } from './package-subscriptions.ts'
import {
	consumeSystemEmailDailyReceive,
	countStoredSystemEmailMessages,
	ensureSystemEmailInbox,
	isSystemEmailLocal,
	systemEmailLimits,
	systemEmailOwnerId,
	type SystemEmailLocal,
} from './system-email.ts'

type ParsedInboundEmail = Awaited<
	ReturnType<typeof parseForwardableEmailMessage>
>

async function parseAndStoreInboundEmail(input: {
	db: D1Database
	message: ForwardableEmailMessage
	recipient: string
	userId: string
	inboxId: string
	maxMessageBytes: number
	onParseRejected: (reason: string) => Promise<void>
}) {
	let parsed: ParsedInboundEmail
	try {
		parsed = await parseForwardableEmailMessage(input.message, {
			maxRawSize: input.maxMessageBytes,
		})
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : 'Failed to parse inbound email.'
		input.message.setReject(reason)
		await input.onParseRejected(reason)
		return null
	}
	const now = new Date().toISOString()
	const subjectNormalized = normalizeSubject(parsed.subject)
	const existingThread = await findEmailThreadForInboundMessage({
		db: input.db,
		userId: input.userId,
		inboxId: input.inboxId,
		references: parsed.references,
		inReplyToHeader: parsed.inReplyTo,
	})
	const thread =
		existingThread ??
		(await createEmailThread({
			db: input.db,
			userId: input.userId,
			inboxId: input.inboxId,
			subjectNormalized,
			rootMessageIdHeader: parsed.messageId,
			lastMessageAt: now,
		}))
	const stored = await insertEmailMessageWithAttachments({
		db: input.db,
		message: {
			direction: 'inbound',
			userId: input.userId,
			inboxId: input.inboxId,
			threadId: thread.id,
			senderIdentityId: null,
			fromAddress: parsed.headerFrom,
			envelopeFrom: parsed.envelopeFrom,
			toAddresses: parsed.to.map((entry) => entry.address),
			ccAddresses: parsed.cc.map((entry) => entry.address),
			bccAddresses: parsed.bcc.map((entry) => entry.address),
			replyToAddresses: parsed.replyTo.map((entry) => entry.address),
			subject: parsed.subject,
			messageIdHeader: parsed.messageId,
			inReplyToHeader: parsed.inReplyTo,
			references: parsed.references,
			headers: parsed.headers,
			authResults: parsed.authResults,
			textBody: parsed.textBody,
			htmlBody: parsed.htmlBody,
			rawMime: parsed.rawMime,
			rawSize: parsed.rawSize,
			processingStatus: 'stored',
			providerMessageId: null,
			error: null,
			receivedAt: now,
			sentAt: null,
		},
		attachments: parsed.attachments.map((attachment) => ({
			filename: attachment.filename,
			contentType: attachment.contentType,
			contentId: attachment.contentId,
			disposition: attachment.disposition,
			size: attachment.size,
			storageKind: 'raw-mime',
			storageKey: null,
		})),
	})
	await touchEmailThread({
		db: input.db,
		threadId: thread.id,
		lastMessageAt: now,
	})
	await insertEmailDeliveryEvent({
		db: input.db,
		messageId: stored.id,
		userId: input.userId,
		inboxId: input.inboxId,
		eventType: 'received',
		provider: 'cloudflare-email-routing',
		detail: {
			recipient: input.recipient,
			envelope_from: parsed.envelopeFrom,
			from_address: parsed.headerFrom,
		},
	})
	return stored
}

export async function handleInboundEmail(
	message: ForwardableEmailMessage,
	env: Pick<
		Env,
		'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL' | 'USAGE_EVENTS'
	>,
	_ctx?: ExecutionContext,
) {
	const recipient = normalizeEmailAddress(message.to)
	if (!recipient) {
		message.setReject('Invalid recipient address.')
		return
	}

	const platformDomain = getPlatformEmailDomain(env)
	if (!platformDomain) {
		message.setReject('Email routing is not configured.')
		return
	}

	const atIndex = recipient.lastIndexOf('@')
	const localPart = recipient.slice(0, atIndex)
	const recipientDomain = recipient.slice(atIndex + 1)
	if (recipientDomain !== platformDomain) {
		message.setReject('Unknown Kody email address.')
		return
	}
	if (isSystemEmailLocal(localPart)) {
		await handleSystemInboundEmail({
			message,
			env,
			recipient,
			localPart,
			platformDomain,
		})
		return
	}
	if (isReservedUsername(localPart)) {
		message.setReject('This address is reserved for system mail.')
		return
	}

	const identity = await findPublicUserIdentityByUsername({
		db: env.APP_DB,
		username: localPart,
	})
	if (!identity) {
		message.setReject('Unknown Kody email address.')
		return
	}

	const userId = identity.mcpUserId
	// The username lookup already resolved the account email, so plan and
	// verified state come from one indexed point read (no stable-id scan).
	const accountRow = await env.APP_DB.prepare(
		`SELECT plan, email_verified_at FROM users WHERE email = ?`,
	)
		.bind(identity.email)
		.first<{ plan: string | null; email_verified_at: string | null }>()
	const account = {
		email: identity.email,
		plan: parsePlanName(accountRow?.plan),
		emailVerified: Boolean(accountRow?.email_verified_at),
	}

	const provisioned = await ensureDefaultEmailInbox({
		db: env.APP_DB,
		userId,
		username: identity.username,
		domain: platformDomain,
	})
	if (!provisioned) {
		message.setReject('Email inbox is unavailable.')
		return
	}
	const { inbox } = provisioned
	if (!inbox.enabled) {
		message.setReject('Email inbox is disabled.')
		return
	}

	const receiveStartedAtMs = Date.now()
	const recordReceiveUsage = async (input: {
		entityId?: string | null
		outcome: 'success' | 'error'
	}) => {
		await recordUsage(env, {
			userId,
			eventType: 'email_received',
			entityId: input.entityId ?? null,
			bytes: message.rawSize,
			durationMs: Date.now() - receiveStartedAtMs,
			outcome: input.outcome,
		})
	}

	// Inbound volume is attacker-controlled (anyone can send to a
	// {username}@<platform domain> address), so every fail-closed gate runs
	// before any parsing work, cheapest rejection first: verified account,
	// per-message size cap, per-day receive rate, and stored-message cap
	// (entitlements with NULL-plan fallbacks).

	// Verified-account gate first: an unverified account can never receive
	// mail, so the attempt must not consume any of the daily receive quota
	// or trip the other counters. Rejection rows go through the bounded
	// recorder because unverified-alias floods are the same
	// attacker-controlled row-growth shape as over-quota floods.
	if (!account.emailVerified) {
		const reason = 'Account email is not verified.'
		message.setReject(reason)
		await recordBoundedEmailRejectionEvent({
			db: env.APP_DB,
			userId,
			inboxId: inbox.id,
			recipient,
			reason,
			phase: 'account-verification',
		}).catch(() => undefined)
		await recordReceiveUsage({ outcome: 'error' })
		return
	}

	// The plan's per-message cap also becomes the parser's raw-MIME ceiling
	// so the two size gates can never disagree; a null (unlimited) plan
	// limit still keeps the parser's hard platform-bound default.
	const maxMessageBytes = resolveEmailResourceLimit(
		account.plan,
		'email_message_bytes',
	)
	try {
		// Size first: an oversize message is rejected without consuming any
		// of the owner's daily receive quota (griefing resistance) and
		// without touching the counters.
		await assertWithinEntitlement({
			db: env.APP_DB,
			userId,
			email: account.email,
			resource: 'email_message_bytes',
			requested: 0,
			getCurrent: async () => message.rawSize,
			fallbackLimit: nullPlanEmailFallbackLimits.email_message_bytes,
		})
		await consumeDailyEntitlement({
			db: env.APP_DB,
			userId,
			email: account.email,
			resource: 'email_receives_per_day',
			fallbackLimit: nullPlanEmailFallbackLimits.email_receives_per_day,
		})
		// Check-then-insert: a concurrent burst can overshoot the stored cap
		// by a few rows, which is the documented row-count-limit trade-off
		// (see entitlements.md "Concurrency") — this is a denial-of-wallet
		// backstop, not billing-grade accounting.
		await assertWithinEntitlement({
			db: env.APP_DB,
			userId,
			email: account.email,
			resource: 'stored_email_messages',
			fallbackLimit: nullPlanEmailFallbackLimits.stored_email_messages,
		})
	} catch (error) {
		if (!isEntitlementLimitError(error)) throw error
		// The SMTP reject reason goes to the arbitrary sender; keep it
		// generic and store the detailed entitlement message for the owner.
		// Rejection rows are bounded per inbox per day because over-quota
		// traffic is exactly the flood these limits exist to absorb.
		message.setReject('Recipient mailbox is over quota.')
		await recordBoundedEmailRejectionEvent({
			db: env.APP_DB,
			userId,
			inboxId: inbox.id,
			recipient,
			reason: error.message,
			phase:
				error.details.resource === 'email_message_bytes'
					? 'size'
					: 'entitlement',
		}).catch(() => undefined)
		await recordReceiveUsage({ outcome: 'error' })
		return
	}

	const stored = await parseAndStoreInboundEmail({
		db: env.APP_DB,
		message,
		recipient,
		userId,
		inboxId: inbox.id,
		maxMessageBytes: maxMessageBytes ?? maxInlineRawMimeBytes,
		async onParseRejected(reason) {
			// Parse failures keep one event per attempt: unlike quota/size
			// rejections they are bounded by the daily receive quota (the
			// counter was already consumed above), and the per-attempt detail
			// is useful for the owner to debug a misbehaving sender.
			await insertEmailDeliveryEvent({
				db: env.APP_DB,
				userId,
				inboxId: inbox.id,
				eventType: 'rejected',
				provider: 'cloudflare-email-routing',
				detail: {
					recipient,
					reason,
					phase: 'parse',
				},
			}).catch(() => undefined)
			await recordReceiveUsage({ outcome: 'error' })
		},
	})
	if (!stored) return
	await recordReceiveUsage({ entityId: stored.id, outcome: 'success' })
	const dispatchPromise = dispatchInboundEmailSubscriptionEvents({
		env,
		userId,
		message: stored,
	})
	if (_ctx) {
		_ctx.waitUntil(dispatchPromise)
	} else {
		void dispatchPromise.catch((error) => {
			console.error('Inbound email package subscription dispatch failed', error)
		})
	}
}

async function handleSystemInboundEmail(input: {
	message: ForwardableEmailMessage
	env: Pick<
		Env,
		'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL' | 'USAGE_EVENTS'
	>
	recipient: string
	localPart: SystemEmailLocal
	platformDomain: string
}) {
	const provisioned = await ensureSystemEmailInbox({
		db: input.env.APP_DB,
		localPart: input.localPart,
		domain: input.platformDomain,
	})
	if (!provisioned) {
		input.message.setReject('Email inbox is unavailable.')
		return
	}
	const { inbox } = provisioned
	const receiveStartedAtMs = Date.now()
	const recordReceiveUsage = async (recordInput: {
		entityId?: string | null
		outcome: 'success' | 'error'
	}) => {
		await recordUsage(input.env, {
			userId: systemEmailOwnerId,
			eventType: 'email_received',
			entityId: recordInput.entityId ?? null,
			bytes: input.message.rawSize,
			durationMs: Date.now() - receiveStartedAtMs,
			outcome: recordInput.outcome,
		})
	}

	if (input.message.rawSize > systemEmailLimits.maxMessageBytes) {
		input.message.setReject('Recipient mailbox is over quota.')
		await recordBoundedEmailRejectionEvent({
			db: input.env.APP_DB,
			userId: systemEmailOwnerId,
			inboxId: inbox.id,
			recipient: input.recipient,
			reason: `Message size ${input.message.rawSize} exceeds system inbox cap ${systemEmailLimits.maxMessageBytes}.`,
			phase: 'size',
		}).catch(() => undefined)
		await recordReceiveUsage({ outcome: 'error' })
		return
	}

	const receivesToday = await consumeSystemEmailDailyReceive({
		db: input.env.APP_DB,
		localPart: input.localPart,
	})
	if (receivesToday === null) {
		input.message.setReject('Recipient mailbox is over quota.')
		await recordBoundedEmailRejectionEvent({
			db: input.env.APP_DB,
			userId: systemEmailOwnerId,
			inboxId: inbox.id,
			recipient: input.recipient,
			reason: `System inbox daily receive cap ${systemEmailLimits.maxReceivesPerDay} reached for ${input.localPart}.`,
			phase: 'system-limit',
		}).catch(() => undefined)
		await recordReceiveUsage({ outcome: 'error' })
		return
	}

	const storedMessages = await countStoredSystemEmailMessages({
		db: input.env.APP_DB,
	})
	if (storedMessages >= systemEmailLimits.maxStoredMessages) {
		input.message.setReject('Recipient mailbox is over quota.')
		await recordBoundedEmailRejectionEvent({
			db: input.env.APP_DB,
			userId: systemEmailOwnerId,
			inboxId: inbox.id,
			recipient: input.recipient,
			reason: `System inbox stored-message cap ${systemEmailLimits.maxStoredMessages} reached.`,
			phase: 'system-limit',
		}).catch(() => undefined)
		await recordReceiveUsage({ outcome: 'error' })
		return
	}

	const stored = await parseAndStoreInboundEmail({
		db: input.env.APP_DB,
		message: input.message,
		recipient: input.recipient,
		userId: systemEmailOwnerId,
		inboxId: inbox.id,
		maxMessageBytes: systemEmailLimits.maxMessageBytes,
		async onParseRejected(reason) {
			await insertEmailDeliveryEvent({
				db: input.env.APP_DB,
				userId: systemEmailOwnerId,
				inboxId: inbox.id,
				eventType: 'rejected',
				provider: 'cloudflare-email-routing',
				detail: {
					recipient: input.recipient,
					reason,
					phase: 'parse',
				},
			}).catch(() => undefined)
			await recordReceiveUsage({ outcome: 'error' })
		},
	})
	if (!stored) return
	await recordReceiveUsage({ entityId: stored.id, outcome: 'success' })
}
