import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import {
	nullPlanEmailFallbackLimits,
	resolveEmailResourceLimit,
} from '#worker/entitlements/plans.ts'
import {
	assertWithinEntitlement,
	consumeDailyEntitlement,
	findUserAccountByStableUserId,
} from '#worker/entitlements/service.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import {
	findReplyTokenHash,
	normalizeEmailAddress,
	normalizeSubject,
} from './address.ts'
import {
	maxInlineRawMimeBytes,
	parseForwardableEmailMessage,
} from './parser.ts'
import {
	createEmailThread,
	findEmailThreadForInboundMessage,
	getEmailInboxById,
	getEmailInboxAddressByAddress,
	getEmailInboxAddressByReplyTokenHash,
	insertEmailDeliveryEvent,
	insertEmailMessageWithAttachments,
	recordBoundedEmailRejectionEvent,
	touchEmailThread,
} from './repo.ts'
import { dispatchInboundEmailSubscriptionEvents } from './package-subscriptions.ts'

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

	const explicitReplyTokenHash = await findReplyTokenHash({
		headers: message.headers,
		recipients: [recipient],
	})
	const inboxAddress =
		(await getEmailInboxAddressByAddress({
			db: env.APP_DB,
			address: recipient,
		})) ??
		(explicitReplyTokenHash
			? await getEmailInboxAddressByReplyTokenHash({
					db: env.APP_DB,
					replyTokenHash: explicitReplyTokenHash,
				})
			: null)
	const inbox = inboxAddress
		? await getEmailInboxById({
				db: env.APP_DB,
				id: inboxAddress.inboxId,
			})
		: null

	if (!inboxAddress) {
		message.setReject('Unknown Kody email alias.')
		return
	}
	if (!inbox) {
		message.setReject('Email inbox is unavailable.')
		return
	}
	if (!inbox.enabled) {
		message.setReject('Email inbox is disabled.')
		return
	}

	const userId = inboxAddress.userId
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

	// Inbound volume is attacker-controlled (anyone who learns an alias can
	// send to it), so every fail-closed gate runs before any parsing work,
	// cheapest rejection first: verified account, per-message size cap,
	// per-day receive rate, and stored-message cap (entitlements with
	// NULL-plan fallbacks). The routing layer has no caller context, so one
	// stable-id reverse lookup resolves the account email, plan, and
	// verified state for all of the gates (same fail-closed stable-id scan
	// `isAccountEmailVerified` uses, with a per-isolate id→email cache).
	const account = await findUserAccountByStableUserId(env.APP_DB, userId)

	// Verified-account gate first: an unverified (or deleted) account can
	// never receive mail, so the attempt must not consume any of the daily
	// receive quota or trip the other counters. Rejection rows go through
	// the bounded recorder because unverified-alias floods are the same
	// attacker-controlled row-growth shape as over-quota floods.
	if (!account?.emailVerified) {
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

	let parsed: Awaited<ReturnType<typeof parseForwardableEmailMessage>>
	try {
		parsed = await parseForwardableEmailMessage(message, {
			maxRawSize: maxMessageBytes ?? maxInlineRawMimeBytes,
		})
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : 'Failed to parse inbound email.'
		// Parse failures keep one event per attempt: unlike quota/size
		// rejections they are bounded by the daily receive quota (the
		// counter was already consumed above), and the per-attempt detail
		// is useful for the owner to debug a misbehaving sender.
		message.setReject(reason)
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
		return
	}
	const now = new Date().toISOString()
	const subjectNormalized = normalizeSubject(parsed.subject)
	const existingThread = await findEmailThreadForInboundMessage({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		references: parsed.references,
		inReplyToHeader: parsed.inReplyTo,
	})
	const thread =
		existingThread ??
		(await createEmailThread({
			db: env.APP_DB,
			userId,
			inboxId: inbox?.id ?? null,
			subjectNormalized,
			rootMessageIdHeader: parsed.messageId,
			lastMessageAt: now,
		}))
	const stored = await insertEmailMessageWithAttachments({
		db: env.APP_DB,
		message: {
			direction: 'inbound',
			userId,
			inboxId: inbox?.id ?? null,
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
		db: env.APP_DB,
		threadId: thread.id,
		lastMessageAt: now,
	})
	await insertEmailDeliveryEvent({
		db: env.APP_DB,
		messageId: stored.id,
		userId,
		inboxId: inbox?.id ?? null,
		eventType: 'received',
		provider: 'cloudflare-email-routing',
		detail: {
			recipient,
			envelope_from: parsed.envelopeFrom,
			from_address: parsed.headerFrom,
		},
	})
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
