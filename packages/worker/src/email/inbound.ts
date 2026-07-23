import { isReservedUsername } from '#app/reserved-usernames.ts'
import { withAccountWriteLease } from '#app/account-deletion-state.ts'
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
import {
	parseForwardableEmailRawMime,
	readForwardableEmailRawMime,
} from './parser.ts'
import {
	adoptLegacyInboundDelivery,
	buildInboundDelivery,
	claimInboundDeliveryWindow,
	claimInboundDeliveryStorage,
	chargeSystemInboundDeliveryOnce,
	chargeUserInboundDeliveryOnce,
	getInboundDeliveryWindow,
	getInboundDelivery,
	markInboundDeliveryRejected,
	pruneExpiredInboundDedupePointers,
	reconcileStaleInboundDeliveries,
	readSystemInboundReceiveCount,
	readUserInboundReceiveCount,
	releaseInboundDeliveryStorage,
	systemInboundQuotaDay,
	type InboundDelivery,
	userInboundQuotaDay,
} from './inbound-delivery.ts'
import {
	getPlatformEmailDomain,
	getSystemEmailDomain,
} from './platform-address.ts'
import { deleteEmptyEmailThreads, getEmailMessageById } from './repo.ts'
import {
	recordBoundedEmailRejectionEvent,
	RetryableInboundStorageError,
	storeIdempotentInboundEmail,
} from './service.ts'
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
}) {
	const transitioned = await markInboundDeliveryRejected({
		db: input.db,
		delivery: input.delivery,
		reason: input.reason,
	}).catch((error: unknown) => {
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
	db: D1Database
	blobs: R2Bucket
	userId: string
}) {
	try {
		await reconcileStaleInboundDeliveries(input)
		await pruneExpiredInboundDedupePointers({
			db: input.db,
			userId: input.userId,
		})
		await deleteEmptyEmailThreads({
			db: input.db,
			userId: input.userId,
			before: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
			limit: 20,
		})
	} catch (error) {
		console.warn('inbound-email-durability-cleanup-failed', input.userId, error)
	}
}

async function scheduleInboundDeliveryEffects(input: {
	env: Parameters<typeof processInboundDeliveryEffects>[0]['env']
	userId: string
	deliveryId: string
	expectedFinalizationToken?: string
	durationMs?: number
	ctx?: ExecutionContext
	logLabel: string
}) {
	const promise = processInboundDeliveryEffects({
		env: input.env,
		userId: input.userId,
		deliveryId: input.deliveryId,
		expectedFinalizationToken: input.expectedFinalizationToken,
		durationMs: input.durationMs,
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
	return await withAccountWriteLease({
		db: env.APP_DB,
		stableUserId: userId,
		async write() {
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
				db: env.APP_DB,
				blobs: env.EMAIL_BLOBS,
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
			const activeWindow = await getInboundDeliveryWindow({
				db: env.APP_DB,
				userId,
				fingerprint: candidateDelivery.fingerprint,
				now: quotaNow,
			})
			let delivery = activeWindow ?? candidateDelivery
			let existingDelivery =
				(await getInboundDelivery({
					db: env.APP_DB,
					userId,
					deliveryId: delivery.deliveryId,
				})) ??
				(await adoptLegacyInboundDelivery({
					db: env.APP_DB,
					blobs: env.EMAIL_BLOBS,
					delivery,
					rawMime,
					rawSize: message.rawSize,
					now: quotaNow,
				}))
			if (!existingDelivery) {
				try {
					// New deliveries check storage bytes and stored-message caps
					// before their durable quota claim. A retry with an existing
					// ledger bypasses both so already-charged mail can still repair
					// after unrelated writes fill the mailbox.
					await assertWithinStorageBytesEntitlement({
						db: env.APP_DB,
						userId,
						email: account.email,
						requested: estimateInboundEmailStorageBytes({
							message,
							recipient,
						}),
					})
					await assertWithinEntitlement({
						db: env.APP_DB,
						userId,
						email: account.email,
						resource: 'stored_email_messages',
					})
					const receiveLimit = resolveEmailResourceLimit(
						account.plan,
						'email_receives_per_day',
					)
					const receivesToday = await readUserInboundReceiveCount({
						db: env.APP_DB,
						userId,
						day: userInboundQuotaDay(quotaNow),
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
			if (!activeWindow) {
				delivery = await claimInboundDeliveryWindow({
					db: env.APP_DB,
					delivery: candidateDelivery,
					now: quotaNow,
				})
				if (
					!existingDelivery ||
					existingDelivery.deliveryId !== delivery.deliveryId
				) {
					existingDelivery =
						(await getInboundDelivery({
							db: env.APP_DB,
							userId,
							deliveryId: delivery.deliveryId,
						})) ??
						(await adoptLegacyInboundDelivery({
							db: env.APP_DB,
							blobs: env.EMAIL_BLOBS,
							delivery,
							rawMime,
							rawSize: message.rawSize,
							now: quotaNow,
						}))
				}
			}
			let claimedDelivery: InboundDelivery
			try {
				claimedDelivery =
					existingDelivery ??
					(await chargeUserInboundDeliveryOnce({
						db: env.APP_DB,
						delivery: {
							...delivery,
							quotaDay: userInboundQuotaDay(quotaNow),
						},
						plan: account.plan,
						limit: resolveEmailResourceLimit(
							account.plan,
							'email_receives_per_day',
						),
						now: quotaNow,
					}))
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
			if (claimedDelivery.state === 'rejected') {
				message.setReject(
					claimedDelivery.rejectionReason ?? 'Failed to parse inbound email.',
				)
				return
			}
			if (claimedDelivery.state === 'received') {
				const existing = await getEmailMessageById({
					db: env.APP_DB,
					userId,
					messageId: claimedDelivery.messageId,
				})
				if (existing) {
					await scheduleInboundDeliveryEffects({
						env,
						userId,
						deliveryId: claimedDelivery.deliveryId,
						durationMs: Date.now() - receiveStartedAtMs,
						ctx: _ctx,
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
				})
				if (!rejected) return
				await recordReceiveUsage({ outcome: 'error' })
				return
			}
			const storageClaim = await claimInboundDeliveryStorage({
				db: env.APP_DB,
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
					db: env.APP_DB,
					blobs: env.EMAIL_BLOBS,
					delivery: storageClaim.delivery,
					parsed,
				})
			} catch (error) {
				await releaseInboundDeliveryStorage({
					db: env.APP_DB,
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
				env,
				userId,
				deliveryId: storedResult.finalizedDelivery.deliveryId,
				expectedFinalizationToken:
					storedResult.finalizedDelivery.finalizationToken,
				durationMs: Date.now() - receiveStartedAtMs,
				ctx: _ctx,
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

	await cleanupInboundDurability({
		db: input.env.APP_DB,
		blobs: input.env.EMAIL_BLOBS,
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
	let existingDelivery =
		(await getInboundDelivery({
			db: input.env.APP_DB,
			userId: systemEmailOwnerId,
			deliveryId: delivery.deliveryId,
		})) ??
		(await adoptLegacyInboundDelivery({
			db: input.env.APP_DB,
			blobs: input.env.EMAIL_BLOBS,
			delivery,
			rawMime,
			rawSize: input.message.rawSize,
			now: quotaNow,
		}))
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
		delivery = await claimInboundDeliveryWindow({
			db: input.env.APP_DB,
			delivery: candidateDelivery,
			now: quotaNow,
		})
		if (
			!existingDelivery ||
			existingDelivery.deliveryId !== delivery.deliveryId
		) {
			existingDelivery =
				(await getInboundDelivery({
					db: input.env.APP_DB,
					userId: systemEmailOwnerId,
					deliveryId: delivery.deliveryId,
				})) ??
				(await adoptLegacyInboundDelivery({
					db: input.env.APP_DB,
					blobs: input.env.EMAIL_BLOBS,
					delivery,
					rawMime,
					rawSize: input.message.rawSize,
					now: quotaNow,
				}))
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
	const storageClaim = await claimInboundDeliveryStorage({
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
		await releaseInboundDeliveryStorage({
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
