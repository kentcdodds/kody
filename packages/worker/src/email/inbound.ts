import { isReservedUsername } from '#worker/identity/reserved-usernames.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { findPublicUserIdentityByUsername } from '#worker/identity/user-lookup.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import {
	parseStoredPlanName,
	resolveEffectivePlan,
	resolveEmailResourceLimit,
} from '#worker/entitlements/plans.ts'
import {
	assertWithinEntitlement,
	estimateEntitlementStorageEntryBytes,
} from '#worker/entitlements/service.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import {
	normalizeEmailAddress,
	normalizeSubject,
	splitEmailLocalPart,
} from './address.ts'
import { ensureDefaultEmailInbox } from './default-inbox.ts'
import { processInboundDeliveryEffects } from './inbound-effects.ts'
import { evaluateEmailSenderRules } from './sender-rules.ts'
import {
	parseForwardableEmailRawMime,
	readForwardableEmailRawMime,
} from './parser.ts'
import {
	buildInboundDelivery,
	chargeSystemInboundDeliveryOnce,
	getInboundDeliveryWindow,
	getInboundDelivery,
	readSystemInboundReceiveCount,
	readUserInboundReceiveCount,
	systemInboundQuotaDay,
	type InboundDelivery,
	userInboundQuotaDay,
} from './inbound-delivery.ts'
import {
	claimSystemInboundDeliveryStorage,
	claimSystemInboundDeliveryWindow,
	markSystemInboundDeliveryRejected,
	pruneSystemExpiredInboundDedupePointers,
	reconcileSystemStaleInboundDeliveries,
	releaseSystemInboundDeliveryStorage,
} from './system-inbound-delivery-authority.ts'
import {
	createUserInboundDeliveryAuthority,
	type UserInboundDeliveryAuthority,
	type UserInboundDeliveryAuthorityEnv,
} from './inbound-delivery-authority.ts'
import {
	pruneUserExpiredInboundDedupePointers,
	reconcileUserStaleInboundDeliveries,
} from './inbound-delivery-reconciliation-authority.ts'
import {
	getPlatformEmailDomain,
	getSystemEmailDomain,
} from './platform-address.ts'
import {
	scheduleInboundReceivedTerminalWork,
	scheduleInboundRejectedTerminalWork,
	type InboundMailboxEnv,
} from './inbound-mailbox.ts'
import { countInternalUserEmailMessages } from './mailbox-internal-read.ts'
import {
	recordEmailReportingEvent,
	type EmailReportingEnv,
} from './reporting-events.ts'
import { deleteEmptyEmailThreads, getEmailMessageById } from './repo.ts'
import {
	recordBoundedEmailRejectionEvent,
	RetryableInboundStorageError,
	storeIdempotentInboundEmail,
} from './service.ts'
import { reserveEmailStorageBytes } from './storage-reservation.ts'
import {
	countStoredSystemEmailMessages,
	ensureSystemEmailInbox,
	isSystemEmailLocal,
	systemEmailLimits,
	systemEmailOwnerId,
	type SystemEmailLocal,
} from './system-email.ts'

/**
 * Rejection audit writes are best-effort (the SMTP reject already happened),
 * but a failure must still be visible to operators — silently losing the
 * rejection trail weakens abuse detection on attacker-controlled paths.
 */
function warnRejectionAuditWriteFailed(error: unknown) {
	console.warn('email-rejection-audit-write-failed', error)
}

async function rejectClaimedInboundDelivery(input: {
	db: D1Database
	message: ForwardableEmailMessage
	delivery: InboundDelivery
	reason: string
	authority?: UserInboundDeliveryAuthority
}) {
	const transitioned = await (
		input.authority
			? input.authority.reject(input.delivery, input.reason)
			: markSystemInboundDeliveryRejected({
					db: input.db,
					delivery: input.delivery,
					reason: input.reason,
				})
	).catch((error: unknown) => {
		warnRejectionAuditWriteFailed(error)
		throw error
	})
	if (transitioned) input.message.setReject(input.reason)
	return transitioned
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
	delivery: InboundDelivery
	parsed: Awaited<ReturnType<typeof parseForwardableEmailRawMime>>
	authority?: UserInboundDeliveryAuthority
}) {
	const now = new Date().toISOString()
	try {
		return await storeIdempotentInboundEmail({
			db: input.db,
			blobs: input.blobs,
			delivery: input.delivery,
			parsed: input.parsed,
			subjectNormalized: normalizeSubject(input.parsed.subject),
			now,
			authority: input.authority,
		})
	} catch (error) {
		if (error instanceof RetryableInboundStorageError) throw error
		throw new RetryableInboundStorageError(
			'Failed to store inbound email before durable commit; delivery should be retried.',
			error,
		)
	}
}

async function cleanupInboundDurability(input: {
	env: UserInboundDeliveryAuthorityEnv & { EMAIL_BLOBS: R2Bucket }
	userId: string
}) {
	try {
		if (input.userId === systemEmailOwnerId) {
			await reconcileSystemStaleInboundDeliveries({
				db: input.env.APP_DB,
				blobs: input.env.EMAIL_BLOBS,
				userId: input.userId,
			})
			await pruneSystemExpiredInboundDedupePointers({
				db: input.env.APP_DB,
				userId: input.userId,
			})
		} else {
			await reconcileUserStaleInboundDeliveries(input)
			await pruneUserExpiredInboundDedupePointers(input)
		}
		await deleteEmptyEmailThreads({
			db: input.env.APP_DB,
			userId: input.userId,
			before: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
			limit: 20,
		})
	} catch (error) {
		console.warn('inbound-email-durability-cleanup-failed', input.userId, error)
	}
}

/** System-inbox effects only (no Mailbox dual-write). */
async function scheduleInboundDeliveryEffects(input: {
	env: Parameters<typeof processInboundDeliveryEffects>[0]['env']
	userId: string
	deliveryId: string
	expectedFinalizationToken?: string
	durationMs?: number
	ctx?: ExecutionContext
	logLabel: string
}) {
	const waitUntil = input.ctx
		? (promise: Promise<unknown>) => input.ctx!.waitUntil(promise)
		: undefined
	const promise = processInboundDeliveryEffects({
		env: input.env,
		userId: input.userId,
		deliveryId: input.deliveryId,
		expectedFinalizationToken: input.expectedFinalizationToken,
		durationMs: input.durationMs,
		waitUntil,
	})
	if (input.ctx) {
		input.ctx.waitUntil(
			promise.catch((error) => {
				console.error(input.logLabel, error)
			}),
		)
		return
	}
	await promise.catch((error) => {
		console.error(input.logLabel, error)
	})
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
		| 'USER_METER'
		| 'MAILBOX'
		| 'EMAIL_EVENTS'
	> &
		EmailReportingEnv &
		InboundMailboxEnv,
	ctx?: ExecutionContext,
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
			ctx,
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
	return await withAccountWriteLease({
		db: env.APP_DB,
		stableUserId: userId,
		async write() {
			const authority = createUserInboundDeliveryAuthority({ env, userId })
			// Require email + canonical stable id together (same contract as
			// getUserPlan / isAccountEmailVerified) so a mismatched identity pair
			// cannot apply another account's plan or verification state.
			const accountRow = await env.APP_DB.prepare(
				`SELECT plan, stripe_plan, email_verified_at, suspended_at FROM users
			WHERE email = ? AND stable_user_id = ?`,
			)
				.bind(identity.email, userId)
				.first<{
					plan: string
					stripe_plan: string | null
					email_verified_at: string | null
					suspended_at: string | null
				}>()
			const account = {
				email: identity.email,
				plan: resolveEffectivePlan(
					// A scoped miss keeps the existing synthetic-account fallback.
					// A present row must satisfy the plan storage contract.
					accountRow ? parseStoredPlanName(accountRow.plan) : 'max',
					accountRow?.stripe_plan ?? null,
				),
				emailVerified: Boolean(accountRow?.email_verified_at),
				suspended: Boolean(accountRow?.suspended_at),
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

			// A platform-suspended account cannot receive mail either; the
			// rejection goes through the same bounded recorder so suspended
			// aliases cannot be used to grow storage.
			if (account.suspended) {
				const reason = 'Account is suspended.'
				message.setReject(reason)
				await recordBoundedEmailRejectionEvent({
					db: env.APP_DB,
					userId,
					inboxId: inbox.id,
					recipient,
					reason,
					phase: 'account-suspension',
				}).catch(warnRejectionAuditWriteFailed)
				await recordReceiveUsage({ outcome: 'error' })
				return
			}

			const senderAddress = normalizeEmailAddress(message.from)
			if (senderAddress) {
				const senderRule = await evaluateEmailSenderRules({
					db: env.APP_DB,
					userId,
					senderAddress,
				})
				if (senderRule?.effect === 'block') {
					const reason = 'Message rejected by recipient policy.'
					message.setReject(reason)
					await recordBoundedEmailRejectionEvent({
						db: env.APP_DB,
						userId,
						inboxId: inbox.id,
						recipient,
						reason,
						phase: 'sender-policy',
					}).catch(warnRejectionAuditWriteFailed)
					await recordReceiveUsage({ outcome: 'error' })
					return
				}
			}

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

			await cleanupInboundDurability({
				env,
				userId,
			})
			let rawMime: string
			try {
				rawMime = await readForwardableEmailRawMime(message)
			} catch (error) {
				throw new RetryableInboundStorageError(
					'Failed to read inbound raw MIME; delivery should be retried.',
					error,
				)
			}
			const quotaNow = new Date()
			const candidateDelivery = await buildInboundDelivery({
				userId,
				inboxId: inbox.id,
				recipient,
				envelopeFrom: message.from,
				rawMime,
				quotaDay: userInboundQuotaDay(quotaNow),
				now: quotaNow,
			})
			const activeWindow = await authority.getWindow(
				candidateDelivery.fingerprint,
				quotaNow,
			)
			const delivery = activeWindow ?? candidateDelivery
			let existingDelivery = await authority.get(delivery.deliveryId)
			if (!existingDelivery) {
				try {
					// New deliveries check storage bytes and stored-message caps
					// before their durable quota claim. A retry with an existing
					// ledger bypasses both so already-charged mail can still repair
					// after unrelated writes fill the mailbox.
					await reserveEmailStorageBytes({
						db: env.APP_DB,
						env,
						userId,
						email: account.email,
						requested: estimateInboundEmailStorageBytes({
							message,
							recipient,
						}),
						waitUntil: ctx
							? (promise: Promise<unknown>) => ctx.waitUntil(promise)
							: undefined,
					})
					await assertWithinEntitlement({
						db: env.APP_DB,
						userId,
						email: account.email,
						resource: 'stored_email_messages',
						getCurrent: async () =>
							await countInternalUserEmailMessages({
								env,
								ownerId: userId,
							}),
					})
					const receiveLimit = resolveEmailResourceLimit(
						account.plan,
						'email_receives_per_day',
					)
					const receivesToday = await readUserInboundReceiveCount({
						db: env.APP_DB,
						env,
						userId,
						day: userInboundQuotaDay(quotaNow),
						now: quotaNow,
					})
					if (receivesToday >= receiveLimit) {
						message.setReject('Recipient mailbox is over quota.')
						await recordBoundedEmailRejectionEvent({
							db: env.APP_DB,
							userId,
							inboxId: inbox.id,
							recipient,
							reason: `Daily receive cap ${receiveLimit} reached.`,
							phase: 'entitlement',
						}).catch(warnRejectionAuditWriteFailed)
						await recordReceiveUsage({ outcome: 'error' })
						return
					}
				} catch (error) {
					if (!isEntitlementLimitError(error)) throw error
					message.setReject('Recipient mailbox is over quota.')
					await recordBoundedEmailRejectionEvent({
						db: env.APP_DB,
						userId,
						inboxId: inbox.id,
						recipient,
						reason: error.message,
						phase: 'entitlement',
					}).catch(warnRejectionAuditWriteFailed)
					await recordReceiveUsage({ outcome: 'error' })
					return
				}
			}
			let claimedDelivery: InboundDelivery
			let chargedReceive = false
			try {
				if (existingDelivery) {
					claimedDelivery = existingDelivery
				} else {
					const chargeCandidate = {
						...delivery,
						quotaDay: userInboundQuotaDay(quotaNow),
					}
					const chargeResult = await authority.charge({
						delivery: chargeCandidate,
						plan: account.plan,
						limit: resolveEmailResourceLimit(
							account.plan,
							'email_receives_per_day',
						),
						now: quotaNow,
					})
					claimedDelivery = chargeResult.delivery
					chargedReceive = chargeResult.charged
				}
			} catch (error) {
				if (!isEntitlementLimitError(error)) throw error
				message.setReject('Recipient mailbox is over quota.')
				await recordBoundedEmailRejectionEvent({
					db: env.APP_DB,
					userId,
					inboxId: inbox.id,
					recipient,
					reason: error.message,
					phase: 'entitlement',
				}).catch(warnRejectionAuditWriteFailed)
				await recordReceiveUsage({ outcome: 'error' })
				return
			}
			if (chargedReceive) {
				recordEmailReportingEvent(env, {
					userId,
					eventType: 'email_receive',
					timestamp: quotaNow.toISOString(),
				})
			}
			if (claimedDelivery.state === 'rejected') {
				message.setReject(
					claimedDelivery.rejectionReason ?? 'Failed to parse inbound email.',
				)
				await scheduleInboundRejectedTerminalWork({
					env,
					userId,
					deliveryId: claimedDelivery.deliveryId,
					ctx,
				})
				return
			}
			if (claimedDelivery.state === 'received') {
				const existing = await getEmailMessageById({
					db: env.APP_DB,
					userId,
					messageId: claimedDelivery.messageId,
				})
				if (existing) {
					await scheduleInboundReceivedTerminalWork({
						env,
						userId,
						messageId: claimedDelivery.messageId,
						deliveryId: claimedDelivery.deliveryId,
						expectedFinalizationToken: claimedDelivery.finalizationToken,
						durationMs: Date.now() - receiveStartedAtMs,
						ctx,
						logLabel: 'Inbound email effect reconciliation failed',
					})
					return
				}
			}
			let parsed
			try {
				parsed = await parseForwardableEmailRawMime(message, rawMime)
			} catch (error) {
				const reason =
					error instanceof Error
						? error.message
						: 'Failed to parse inbound email.'
				const rejected = await rejectClaimedInboundDelivery({
					db: env.APP_DB,
					message,
					delivery: claimedDelivery,
					reason,
					authority,
				})
				if (!rejected) return
				await recordReceiveUsage({ outcome: 'error' })
				await scheduleInboundRejectedTerminalWork({
					env,
					userId,
					deliveryId: claimedDelivery.deliveryId,
					ctx,
				})
				return
			}
			const storageClaim = await authority.claimStorage(
				claimedDelivery,
				parsed.attachments.length,
				new Date(receiveStartedAtMs).toISOString(),
			)
			if (!storageClaim.claimed) {
				if (storageClaim.delivery?.state === 'received') {
					await scheduleInboundReceivedTerminalWork({
						env,
						userId,
						messageId: claimedDelivery.messageId,
						deliveryId: storageClaim.delivery.deliveryId,
						expectedFinalizationToken: storageClaim.delivery.finalizationToken,
						durationMs: Date.now() - receiveStartedAtMs,
						ctx,
						logLabel: 'Inbound email effect reconciliation failed',
					})
					return
				}
				throw new RetryableInboundStorageError(
					'Inbound delivery is already being stored; retry the stable delivery.',
				)
			}
			let storedResult
			try {
				storedResult = await parseAndStoreInboundEmail({
					db: env.APP_DB,
					blobs: env.EMAIL_BLOBS,
					delivery: storageClaim.delivery,
					parsed,
					authority,
				})
			} catch (error) {
				await authority
					.releaseStorage(storageClaim.delivery)
					.catch((releaseError) => {
						console.error(
							'inbound-email-storage-lease-release-failed',
							storageClaim.delivery.deliveryId,
							releaseError,
						)
					})
				throw error
			}
			// Mailbox dual-write only after durable D1/R2 commit + finalization win.
			if (!storedResult.wonFinalization) return
			await scheduleInboundReceivedTerminalWork({
				env,
				userId,
				messageId: storedResult.finalizedDelivery.messageId,
				deliveryId: storedResult.finalizedDelivery.deliveryId,
				expectedFinalizationToken:
					storedResult.finalizedDelivery.finalizationToken,
				durationMs: Date.now() - receiveStartedAtMs,
				ctx,
				logLabel: 'Inbound email effect dispatch failed',
			})
		},
	})
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
		| 'MAILBOX'
		| 'USER_METER'
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

	const systemSenderAddress = normalizeEmailAddress(input.message.from)
	if (systemSenderAddress) {
		const senderRule = await evaluateEmailSenderRules({
			db: input.env.APP_DB,
			userId: systemEmailOwnerId,
			senderAddress: systemSenderAddress,
		})
		if (senderRule?.effect === 'block') {
			const reason = 'Message rejected by recipient policy.'
			input.message.setReject(reason)
			await recordBoundedEmailRejectionEvent({
				db: input.env.APP_DB,
				userId: systemEmailOwnerId,
				inboxId: inbox.id,
				recipient: input.recipient,
				reason,
				phase: 'sender-policy',
			}).catch(warnRejectionAuditWriteFailed)
			await recordReceiveUsage({ outcome: 'error' })
			return
		}
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

	await cleanupInboundDurability({
		env: input.env,
		userId: systemEmailOwnerId,
	})
	let rawMime: string
	try {
		rawMime = await readForwardableEmailRawMime(input.message)
	} catch (error) {
		throw new RetryableInboundStorageError(
			'Failed to read inbound raw MIME; delivery should be retried.',
			error,
		)
	}
	const quotaNow = new Date()
	const candidateDelivery = await buildInboundDelivery({
		userId: systemEmailOwnerId,
		inboxId: inbox.id,
		recipient: input.recipient,
		envelopeFrom: input.message.from,
		rawMime,
		quotaDay: systemInboundQuotaDay(quotaNow),
		now: quotaNow,
	})
	const activeWindow = await getInboundDeliveryWindow({
		db: input.env.APP_DB,
		userId: systemEmailOwnerId,
		fingerprint: candidateDelivery.fingerprint,
		now: quotaNow,
	})
	let delivery = activeWindow ?? candidateDelivery
	let existingDelivery = await getInboundDelivery({
		db: input.env.APP_DB,
		userId: systemEmailOwnerId,
		deliveryId: delivery.deliveryId,
	})
	if (!existingDelivery) {
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
		const receivesToday = await readSystemInboundReceiveCount({
			db: input.env.APP_DB,
			localPart: input.localPart,
			day: systemInboundQuotaDay(quotaNow),
		})
		if (receivesToday >= systemEmailLimits.maxReceivesPerDay) {
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
	}
	if (!activeWindow) {
		delivery = await claimSystemInboundDeliveryWindow({
			db: input.env.APP_DB,
			delivery: candidateDelivery,
			now: quotaNow,
		})
		if (
			!existingDelivery ||
			existingDelivery.deliveryId !== delivery.deliveryId
		) {
			existingDelivery = await getInboundDelivery({
				db: input.env.APP_DB,
				userId: systemEmailOwnerId,
				deliveryId: delivery.deliveryId,
			})
		}
	}
	const claim = existingDelivery
		? { delivery: existingDelivery, overLimit: false as const }
		: await chargeSystemInboundDeliveryOnce({
				db: input.env.APP_DB,
				delivery: {
					...delivery,
					quotaDay: systemInboundQuotaDay(quotaNow),
				},
				localPart: input.localPart,
				limit: systemEmailLimits.maxReceivesPerDay,
				now: quotaNow,
			})
	if (claim.overLimit || !claim.delivery) {
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
	const claimedDelivery = claim.delivery
	if (claimedDelivery.state === 'rejected') {
		input.message.setReject(
			claimedDelivery.rejectionReason ?? 'Failed to parse inbound email.',
		)
		return
	}
	if (claimedDelivery.state === 'received') {
		const existing = await getEmailMessageById({
			db: input.env.APP_DB,
			userId: systemEmailOwnerId,
			messageId: claimedDelivery.messageId,
		})
		if (existing) {
			await scheduleInboundDeliveryEffects({
				env: input.env,
				userId: systemEmailOwnerId,
				deliveryId: claimedDelivery.deliveryId,
				durationMs: Date.now() - receiveStartedAtMs,
				ctx: input.ctx,
				logLabel: 'System inbound email effect reconciliation failed',
			})
			return
		}
	}
	let parsed
	try {
		parsed = await parseForwardableEmailRawMime(input.message, rawMime)
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : 'Failed to parse inbound email.'
		const rejected = await rejectClaimedInboundDelivery({
			db: input.env.APP_DB,
			message: input.message,
			delivery: claimedDelivery,
			reason,
		})
		if (!rejected) return
		await recordReceiveUsage({ outcome: 'error' })
		return
	}
	const storageClaim = await claimSystemInboundDeliveryStorage({
		db: input.env.APP_DB,
		delivery: claimedDelivery,
		expectedAttachmentCount: parsed.attachments.length,
		usageStartedAt: new Date(receiveStartedAtMs).toISOString(),
	})
	if (!storageClaim.claimed) {
		if (storageClaim.delivery?.state === 'received') return
		throw new RetryableInboundStorageError(
			'Inbound delivery is already being stored; retry the stable delivery.',
		)
	}
	let storedResult
	try {
		storedResult = await parseAndStoreInboundEmail({
			db: input.env.APP_DB,
			blobs: input.env.EMAIL_BLOBS,
			delivery: storageClaim.delivery,
			parsed,
		})
	} catch (error) {
		await releaseSystemInboundDeliveryStorage({
			db: input.env.APP_DB,
			delivery: storageClaim.delivery,
		}).catch((releaseError) => {
			console.error(
				'inbound-email-storage-lease-release-failed',
				storageClaim.delivery.deliveryId,
				releaseError,
			)
		})
		throw error
	}
	if (!storedResult.wonFinalization) return
	await scheduleInboundDeliveryEffects({
		env: input.env,
		userId: systemEmailOwnerId,
		deliveryId: storedResult.finalizedDelivery.deliveryId,
		expectedFinalizationToken: storedResult.finalizedDelivery.finalizationToken,
		durationMs: Date.now() - receiveStartedAtMs,
		ctx: input.ctx,
		logLabel: 'System inbound email effect dispatch failed',
	})
}
