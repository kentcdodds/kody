import { isReservedUsername } from '#app/reserved-usernames.ts'
import { findPublicUserIdentityByUsername } from '#app/user-lookup.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import {
	parseStoredPlanName,
	resolveEffectivePlan,
	resolveEmailResourceLimit,
} from '#worker/entitlements/plans.ts'
import {
	assertWithinEntitlement,
	assertWithinStorageBytesEntitlement,
	consumeDailyEntitlement,
	estimateEntitlementStorageEntryBytes,
	refundDailyEntitlement,
} from '#worker/entitlements/service.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import {
	normalizeEmailAddress,
	normalizeSubject,
	splitEmailLocalPart,
} from './address.ts'
import { ensureDefaultEmailInbox } from './default-inbox.ts'
import { parseForwardableEmailMessage } from './parser.ts'
import {
	getPlatformEmailDomain,
	getSystemEmailDomain,
} from './platform-address.ts'
import {
	createEmailThread,
	findEmailThreadForInboundMessage,
	insertEmailDeliveryEvent,
	insertEmailMessageWithAttachments,
	recordBoundedEmailRejectionEvent,
	RetryableInboundStorageError,
	touchEmailThread,
} from './service.ts'
import {
	dispatchInboundEmailSubscriptionEvents,
	dispatchSystemInboundEmailSubscriptionEvents,
} from './package-subscriptions.ts'
import {
	consumeSystemEmailDailyReceive,
	countStoredSystemEmailMessages,
	ensureSystemEmailInbox,
	isSystemEmailLocal,
	refundSystemEmailDailyReceive,
	systemEmailLimits,
	systemEmailOwnerId,
	type SystemEmailLocal,
} from './system-email.ts'

/**
 * Best-effort refund of a pre-parse daily receive charge after a retryable
 * storage failure. Logs refund failures but never masks the original error.
 */
async function refundReceiveQuotaAfterStorageFailure(input: {
	refund: () => Promise<void>
	logLabel: string
}): Promise<void> {
	try {
		await input.refund()
	} catch (refundError) {
		console.error(input.logLabel, refundError)
	}
}

type ParsedInboundEmail = Awaited<
	ReturnType<typeof parseForwardableEmailMessage>
>

/**
 * Rejection audit writes are best-effort (the SMTP reject already happened),
 * but a failure must still be visible to operators — silently losing the
 * rejection trail weakens abuse detection on attacker-controlled paths.
 */
function warnRejectionAuditWriteFailed(error: unknown) {
	console.warn('email-rejection-audit-write-failed', error)
}

function estimateInboundEmailStorageBytes(input: {
	message: ForwardableEmailMessage
	recipient: string
}) {
	return (
		input.message.rawSize * 2 +
		estimateEntitlementStorageEntryBytes({
			value: {
				from: input.message.from,
				to: input.message.to,
				recipient: input.recipient,
				headers: Object.fromEntries(input.message.headers.entries()),
			},
		})
	)
}

async function parseAndStoreInboundEmail(input: {
	db: D1Database
	blobs: R2Bucket
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
	// Durable commit boundary: thread prework + message/attachment storage are
	// pre-commit (RetryableInboundStorageError → refund + Email Routing retry).
	// touchEmailThread / received delivery-event writes are post-commit and must
	// not throw after the message row is durable (retry would duplicate mail).
	let thread
	let stored
	try {
		const existingThread = await findEmailThreadForInboundMessage({
			db: input.db,
			userId: input.userId,
			inboxId: input.inboxId,
			references: parsed.references,
			inReplyToHeader: parsed.inReplyTo,
		})
		thread =
			existingThread ??
			(await createEmailThread({
				db: input.db,
				userId: input.userId,
				inboxId: input.inboxId,
				subjectNormalized,
				rootMessageIdHeader: parsed.messageId,
				lastMessageAt: now,
			}))
		stored = await insertEmailMessageWithAttachments({
			db: input.db,
			blobs: input.blobs,
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
	} catch (error) {
		if (error instanceof RetryableInboundStorageError) throw error
		throw new RetryableInboundStorageError(
			'Failed to store inbound email before durable commit; delivery should be retried.',
			error,
		)
	}
	try {
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
	} catch (error) {
		console.error(
			'inbound-email-post-commit-bookkeeping-failed',
			stored.id,
			error,
		)
	}
	return stored
}

export async function handleInboundEmail(
	message: ForwardableEmailMessage,
	env: Pick<
		Env,
		| 'APP_DB'
		| 'EMAIL_BLOBS'
		| 'BUNDLE_ARTIFACTS_KV'
		| 'APP_BASE_URL'
		| 'USER_EMAIL_DOMAIN'
		| 'USAGE_EVENTS'
	>,
	_ctx?: ExecutionContext,
) {
	const recipient = normalizeEmailAddress(message.to)
	if (!recipient) {
		message.setReject('Invalid recipient address.')
		return
	}

	const platformDomain = getPlatformEmailDomain(env)
	const systemDomain = getSystemEmailDomain(env)
	if (!platformDomain && !systemDomain) {
		message.setReject('Email routing is not configured.')
		return
	}

	const atIndex = recipient.lastIndexOf('@')
	const localPart = recipient.slice(0, atIndex)
	const recipientDomain = recipient.slice(atIndex + 1)
	// RFC 5233 subaddressing: `user+tag@...` routes like `user@...`. The
	// full tagged address stays visible in the stored message's
	// to_addresses, so automations (for example email.message.received
	// package handlers) can dispatch on the tag.
	const { base: localBase } = splitEmailLocalPart(localPart)
	// Operator-owned system inboxes live on the apex domain, next to the
	// kody@<apex> transactional sender whose replies they receive. User mail
	// lives exclusively on the user subdomain; all other apex mail rejects.
	if (
		systemDomain &&
		recipientDomain === systemDomain &&
		isSystemEmailLocal(localBase)
	) {
		await handleSystemInboundEmail({
			message,
			env,
			recipient,
			localPart: localBase,
			systemDomain,
			ctx: _ctx,
		})
		return
	}
	if (!platformDomain || recipientDomain !== platformDomain) {
		message.setReject('Unknown Kody email address.')
		return
	}
	if (isReservedUsername(localBase)) {
		message.setReject('This address is reserved for system mail.')
		return
	}

	const identity = await findPublicUserIdentityByUsername({
		db: env.APP_DB,
		username: localBase,
	})
	if (!identity) {
		message.setReject('Unknown Kody email address.')
		return
	}

	const userId = identity.mcpUserId
	// Require email + canonical stable id together (same contract as
	// getUserPlan / isAccountEmailVerified) so a mismatched identity pair
	// cannot apply another account's plan or verification state.
	const accountRow = await env.APP_DB.prepare(
		`SELECT plan, stripe_plan, email_verified_at FROM users
			WHERE email = ? AND stable_user_id = ?`,
	)
		.bind(identity.email, userId)
		.first<{
			plan: string
			stripe_plan: string | null
			email_verified_at: string | null
		}>()
	const account = {
		email: identity.email,
		plan: resolveEffectivePlan(
			// Defensive: missing row or unexpected stored value still fails open.
			parseStoredPlanName(accountRow?.plan),
			accountRow?.stripe_plan ?? null,
		),
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
	// per-message size cap, storage bytes, per-day receive rate, and
	// stored-message cap (entitlements, including max-plan email caps).

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
		}).catch(warnRejectionAuditWriteFailed)
		await recordReceiveUsage({ outcome: 'error' })
		return
	}

	// The plan's per-message cap also becomes the parser's raw-MIME ceiling
	// so the two size gates can never disagree.
	const maxMessageBytes = resolveEmailResourceLimit(
		account.plan,
		'email_message_bytes',
	)
	// Captured at consume time so a storage-failure refund uses the same UTC day.
	let receiveQuotaNow: Date | null = null
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
		})
		await assertWithinStorageBytesEntitlement({
			db: env.APP_DB,
			userId,
			email: account.email,
			requested: estimateInboundEmailStorageBytes({ message, recipient }),
		})
		receiveQuotaNow = new Date()
		await consumeDailyEntitlement({
			db: env.APP_DB,
			userId,
			email: account.email,
			resource: 'email_receives_per_day',
			now: receiveQuotaNow,
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
		}).catch(warnRejectionAuditWriteFailed)
		await recordReceiveUsage({ outcome: 'error' })
		return
	}

	let stored
	try {
		stored = await parseAndStoreInboundEmail({
			db: env.APP_DB,
			blobs: env.EMAIL_BLOBS,
			message,
			recipient,
			userId,
			inboxId: inbox.id,
			maxMessageBytes,
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
				}).catch(warnRejectionAuditWriteFailed)
				await recordReceiveUsage({ outcome: 'error' })
			},
		})
	} catch (error) {
		// Only typed pre-commit failures refund + retry. Post-commit
		// bookkeeping is swallowed inside parseAndStoreInboundEmail.
		if (!(error instanceof RetryableInboundStorageError)) throw error
		const chargedAt = receiveQuotaNow
		if (chargedAt) {
			await refundReceiveQuotaAfterStorageFailure({
				logLabel: 'email-receives-daily-refund-failed',
				refund: () =>
					refundDailyEntitlement({
						db: env.APP_DB,
						userId,
						resource: 'email_receives_per_day',
						now: chargedAt,
					}),
			})
		}
		throw error
	}
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
		| 'APP_DB'
		| 'EMAIL_BLOBS'
		| 'BUNDLE_ARTIFACTS_KV'
		| 'APP_BASE_URL'
		| 'USAGE_EVENTS'
	>
	recipient: string
	localPart: SystemEmailLocal
	systemDomain: string
	ctx?: ExecutionContext
}) {
	const provisioned = await ensureSystemEmailInbox({
		db: input.env.APP_DB,
		localPart: input.localPart,
		domain: input.systemDomain,
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
		}).catch(warnRejectionAuditWriteFailed)
		await recordReceiveUsage({ outcome: 'error' })
		return
	}

	// Same-day key for consume + possible storage-failure refund.
	const receiveQuotaNow = new Date()
	const receivesToday = await consumeSystemEmailDailyReceive({
		db: input.env.APP_DB,
		localPart: input.localPart,
		now: receiveQuotaNow,
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
		}).catch(warnRejectionAuditWriteFailed)
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
		}).catch(warnRejectionAuditWriteFailed)
		await recordReceiveUsage({ outcome: 'error' })
		return
	}

	let stored
	try {
		stored = await parseAndStoreInboundEmail({
			db: input.env.APP_DB,
			blobs: input.env.EMAIL_BLOBS,
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
				}).catch(warnRejectionAuditWriteFailed)
				await recordReceiveUsage({ outcome: 'error' })
			},
		})
	} catch (error) {
		if (!(error instanceof RetryableInboundStorageError)) throw error
		await refundReceiveQuotaAfterStorageFailure({
			logLabel: 'system-email-receives-daily-refund-failed',
			refund: () =>
				refundSystemEmailDailyReceive({
					db: input.env.APP_DB,
					localPart: input.localPart,
					now: receiveQuotaNow,
				}),
		})
		throw error
	}
	if (!stored) return
	await recordReceiveUsage({ entityId: stored.id, outcome: 'success' })
	// System mail fans out to packages saved by admin users on the dedicated
	// email.system-message.received topic (never to the synthetic system
	// owner, which has no saved packages).
	const dispatchPromise = dispatchSystemInboundEmailSubscriptionEvents({
		env: input.env,
		message: stored,
	})
	if (input.ctx) {
		input.ctx.waitUntil(dispatchPromise)
	} else {
		void dispatchPromise.catch((error) => {
			console.error(
				'System inbound email package subscription dispatch failed',
				error,
			)
		})
	}
}
