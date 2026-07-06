import { isAccountEmailVerified } from '#app/email-verification.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { nullPlanEmailFallbackLimits } from '#worker/entitlements/plans.ts'
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
import { parseForwardableEmailMessage } from './parser.ts'
import {
	createEmailThread,
	findEmailThreadForInboundMessage,
	getEmailInboxById,
	getEmailInboxAddressByAddress,
	getEmailInboxAddressByReplyTokenHash,
	insertEmailDeliveryEvent,
	insertEmailMessageWithAttachments,
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

	// Inbox rows only store the stable user id, so this uses the stable-id
	// scan inside `isAccountEmailVerified` (same pattern as outbound send).
	// Cost is O(users) hashing per inbound message; if user counts grow
	// enough to matter, add an indexed stable-id column on `users` instead
	// of weakening this fail-closed check.
	const accountEmailVerified = await isAccountEmailVerified({
		db: env.APP_DB,
		stableUserId: userId,
	})
	if (!accountEmailVerified) {
		const reason = 'Account email is not verified.'
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
				phase: 'account-verification',
			},
		}).catch(() => undefined)
		return
	}

	// Inbound volume is attacker-controlled (anyone who learns an alias can
	// send to it), so storage is gated before any parsing work: a per-day
	// receive rate and a stored-message cap, with NULL-plan fallbacks. The
	// routing layer has no caller context, so the account email for the plan
	// lookup is reverse-resolved from the stable user id.
	try {
		const account = await findUserAccountByStableUserId(env.APP_DB, userId)
		await consumeDailyEntitlement({
			db: env.APP_DB,
			userId,
			email: account?.email,
			resource: 'email_receives_per_day',
			fallbackLimit: nullPlanEmailFallbackLimits.email_receives_per_day,
		})
		await assertWithinEntitlement({
			db: env.APP_DB,
			userId,
			email: account?.email,
			resource: 'stored_email_messages',
			fallbackLimit: nullPlanEmailFallbackLimits.stored_email_messages,
		})
	} catch (error) {
		if (!isEntitlementLimitError(error)) throw error
		// The SMTP reject reason goes to the arbitrary sender; keep it
		// generic and store the detailed entitlement message for the owner.
		message.setReject('Recipient mailbox is over quota.')
		await insertEmailDeliveryEvent({
			db: env.APP_DB,
			userId,
			inboxId: inbox.id,
			eventType: 'rejected',
			provider: 'cloudflare-email-routing',
			detail: {
				recipient,
				reason: error.message,
				phase: 'entitlement',
			},
		}).catch(() => undefined)
		await recordReceiveUsage({ outcome: 'error' })
		return
	}

	let parsed: Awaited<ReturnType<typeof parseForwardableEmailMessage>>
	try {
		parsed = await parseForwardableEmailMessage(message)
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : 'Failed to parse inbound email.'
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
