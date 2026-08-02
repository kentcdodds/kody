import {
	buildEntitlementUpgradeHint,
	EntitlementLimitError,
} from '#worker/entitlements/errors.ts'
import { type PlanName } from '#worker/entitlements/plans.ts'
import {
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
import {
	InboundDeliveryLeaseLostError,
	type InboundDelivery,
} from './inbound-delivery.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import {
	type MailboxClaimInboundSubscriptionEffectResult,
	type MailboxClaimInboundUsageEffectResult,
	type MailboxCompleteInboundSubscriptionEffectResult,
	type MailboxCompleteInboundUsageEffectResult,
	type MailboxFailInboundSubscriptionEffectResult,
	type MailboxListDueInboundEffectWorkResult,
} from './mailbox-inbound-effect-ledger.ts'
import {
	mailboxInboundDedupePointerId,
	mailboxInboundDedupeProvider,
	type MailboxClaimInboundDeliveryCleanupResult,
	type MailboxDeferInboundDeliveryReconcileResult,
	type MailboxInboundDeliveryInsertInput,
	type MailboxInboundDeliverySnapshot,
	type MailboxListDueStaleInboundDeliveriesResult,
	type MailboxMarkInboundDeliveryOrphanCleanedResult,
	type MailboxReleaseInboundDeliveryCleanupResult,
} from './mailbox-inbound-ledger.ts'
import {
	bootstrapUserInboundDeliveryFromD1,
	bootstrapUserInboundDeliveryWindowFromD1,
	mirrorUserInboundDeliverySnapshotToD1,
	toUserInboundDelivery,
} from './inbound-delivery-projection.ts'
import { systemEmailOwnerId } from './email-owner.ts'

export { mirrorUserInboundDeliverySnapshotToD1 } from './inbound-delivery-projection.ts'

export type UserInboundDeliveryAuthorityEnv = {
	APP_DB: D1Database
} & MailboxEnv &
	UserMeterEnv

export type CreateUserInboundDeliveryAuthorityInput = {
	env: UserInboundDeliveryAuthorityEnv
	userId: string
}

export type UserInboundDeliveryChargeInput = {
	delivery: InboundDelivery
	plan: PlanName
	limit: number
	now: Date
}

export type UserInboundDeliveryChargeResult = {
	delivery: InboundDelivery
	charged: boolean
}

export type UserInboundDeliveryReceiveInput = {
	delivery: InboundDelivery
	usageDurationMs: number
	usageMonth: string
	usageBytes: number
	now?: Date
}

export type UserInboundDeliveryStorageClaimResult =
	| { claimed: true; delivery: InboundDelivery }
	| { claimed: false; delivery: InboundDelivery | null }

export type UserInboundDeliveryOrphanCleanedInput = {
	deliveryId: string
	cleanupLease: string
	outcome: 'deleted' | 'delete-failed'
	now?: Date
}

export type UserInboundDeliveryCleanupClaimInput = {
	deliveryId: string
	expectedState: InboundDelivery['state']
	expectedUpdatedAt: string
	staleBefore: Date
	now?: Date
}

export type UserInboundUsageEffectClaimInput = {
	deliveryId: string
	expectedFinalizationToken?: string
	now?: Date
}

export type UserInboundUsageEffectCompleteInput = {
	deliveryId: string
	usageEffectLease: string
	expectedFinalizationToken: string
	mode: 'recorded' | 'suppressed'
	usageMonth: string
	usageBytes: number
	usageDurationMs: number
	now?: Date
}

export type UserInboundSubscriptionEffectClaimInput = {
	deliveryId: string
	expectedFinalizationToken?: string
	now?: Date
}

export type UserInboundSubscriptionEffectCompleteInput = {
	deliveryId: string
	subscriptionEffectLease: string
	expectedFinalizationToken: string
	mode: 'complete' | 'suppressed'
	suppressionReason?: string
	now?: Date
}

export type UserInboundSubscriptionEffectFailInput = {
	deliveryId: string
	subscriptionEffectLease: string
	expectedFinalizationToken: string
	error: string
	now?: Date
}

export type UserInboundDeliveryAuthority = {
	get: (deliveryId: string) => Promise<InboundDelivery | null>
	getWindow: (fingerprint: string, now: Date) => Promise<InboundDelivery | null>
	claimWindow: (
		delivery: InboundDelivery,
		now: Date,
	) => Promise<InboundDelivery>
	charge: (
		input: UserInboundDeliveryChargeInput,
	) => Promise<UserInboundDeliveryChargeResult>
	claimStorage: (
		delivery: InboundDelivery,
		expectedAttachmentCount: number,
		usageStartedAt?: string,
		now?: Date,
	) => Promise<UserInboundDeliveryStorageClaimResult>
	releaseStorage: (delivery: InboundDelivery, now?: Date) => Promise<void>
	reject: (
		delivery: InboundDelivery,
		reason: string,
		now?: Date,
	) => Promise<InboundDelivery | null>
	receive: (input: UserInboundDeliveryReceiveInput) => Promise<InboundDelivery>
	deferReconciliation: (
		deliveryId: string,
		now?: Date,
	) => Promise<MailboxDeferInboundDeliveryReconcileResult>
	listDueStale: (
		now?: Date,
		limit?: number,
	) => Promise<MailboxListDueStaleInboundDeliveriesResult>
	claimCleanup: (
		input: UserInboundDeliveryCleanupClaimInput,
	) => Promise<MailboxClaimInboundDeliveryCleanupResult>
	releaseCleanup: (
		deliveryId: string,
		cleanupLease: string,
		now?: Date,
	) => Promise<MailboxReleaseInboundDeliveryCleanupResult>
	markOrphanCleaned: (
		input: UserInboundDeliveryOrphanCleanedInput,
	) => Promise<MailboxMarkInboundDeliveryOrphanCleanedResult>
	pruneExpiredDedupe: (now?: Date, limit?: number) => Promise<number>
	claimUsageEffect: (
		input: UserInboundUsageEffectClaimInput,
	) => Promise<MailboxClaimInboundUsageEffectResult>
	completeUsageEffect: (
		input: UserInboundUsageEffectCompleteInput,
	) => Promise<MailboxCompleteInboundUsageEffectResult>
	claimSubscriptionEffect: (
		input: UserInboundSubscriptionEffectClaimInput,
	) => Promise<MailboxClaimInboundSubscriptionEffectResult>
	completeSubscriptionEffect: (
		input: UserInboundSubscriptionEffectCompleteInput,
	) => Promise<MailboxCompleteInboundSubscriptionEffectResult>
	failSubscriptionEffect: (
		input: UserInboundSubscriptionEffectFailInput,
	) => Promise<MailboxFailInboundSubscriptionEffectResult>
	listDueEffects: (
		now?: Date,
		limit?: number,
	) => Promise<MailboxListDueInboundEffectWorkResult>
}

function toInsertInput(
	delivery: InboundDelivery,
): MailboxInboundDeliveryInsertInput {
	return {
		fingerprint: delivery.fingerprint,
		deliveryId: delivery.deliveryId,
		messageId: delivery.messageId,
		threadId: delivery.threadId,
		rawMimeKey: delivery.rawMimeKey,
		inboxId: delivery.inboxId,
		recipient: delivery.recipient,
		envelopeFrom: delivery.envelopeFrom,
		provider: delivery.provider,
		quotaDay: delivery.quotaDay,
		dedupeExpiresAt: delivery.dedupeExpiresAt,
		usageStartedAt: delivery.usageStartedAt,
	}
}

export function createUserInboundDeliveryAuthority(
	input: CreateUserInboundDeliveryAuthorityInput,
): UserInboundDeliveryAuthority {
	const { env, userId } = input
	if (userId === systemEmailOwnerId) {
		throw new Error(
			'system:email inbound delivery authority must remain in D1.',
		)
	}
	const mailbox = mailboxRpc({ env, userId })
	const mirror = async (
		snapshot: MailboxInboundDeliverySnapshot,
		options?: { eventId?: string; provider?: string },
	) => {
		await mirrorUserInboundDeliverySnapshotToD1({
			db: env.APP_DB,
			userId,
			snapshot,
			...options,
		})
		return toUserInboundDelivery(userId, snapshot)
	}
	const mirrorClaimBestEffort = async (
		snapshot: MailboxInboundDeliverySnapshot,
		logLabel: string,
	) => {
		await mirror(snapshot).catch((error: unknown) => {
			console.warn(logLabel, userId, snapshot.deliveryId, error)
		})
	}
	/**
	 * Mailbox is authoritative. A successful point read synchronously repairs
	 * the D1 compatibility projection; only a Mailbox miss may invoke the
	 * one-time pre-deploy bootstrap bridge.
	 */
	const get = async (deliveryId: string) => {
		const current =
			(await mailbox.getInboundDelivery({ ownerId: userId, deliveryId })) ??
			(await bootstrapUserInboundDeliveryFromD1({ env, userId, deliveryId }))
		return current ? await mirror(current) : null
	}
	const getWindow = async (fingerprint: string, now: Date) => {
		const current =
			(await mailbox.getInboundDeliveryWindow({
				ownerId: userId,
				fingerprint,
				now: now.toISOString(),
			})) ??
			(await bootstrapUserInboundDeliveryWindowFromD1({
				env,
				userId,
				fingerprint,
				now,
			}))
		return current
			? await mirror(current, {
					eventId: mailboxInboundDedupePointerId(fingerprint),
					provider: mailboxInboundDedupeProvider,
				})
			: null
	}
	const claimWindow = async (delivery: InboundDelivery, now: Date) => {
		const snapshot = await mailbox.claimInboundDeliveryWindow({
			ownerId: userId,
			delivery: toInsertInput(delivery),
			now: now.toISOString(),
		})
		return await mirror(snapshot, {
			eventId: mailboxInboundDedupePointerId(delivery.fingerprint),
			provider: mailboxInboundDedupeProvider,
		})
	}
	const charge = async (chargeInput: UserInboundDeliveryChargeInput) => {
		// Resolve the canonical dedupe winner before charging. Concurrent
		// boundary candidates therefore consume quota only under the winner id.
		const claimedDelivery = await claimWindow(
			chargeInput.delivery,
			chargeInput.now,
		)
		const existing = await get(claimedDelivery.deliveryId)
		if (existing) return { delivery: existing, charged: false }
		const chargedDelivery = {
			...claimedDelivery,
			quotaDay: chargeInput.delivery.quotaDay,
		}
		const updatedAt = chargeInput.now.toISOString()
		const meter = userMeterRpc({ env, userId })
		// Accepted non-atomic cross-DO window: if Email Routing exhausts retries
		// after UserMeter consume but before Mailbox insert, one daily receive unit
		// may burn until reset. Replays self-heal while retries continue and cannot
		// duplicate a message because both operations use the dedupe winner id.
		let meterResult = await meter.consumeInboundDelivery({
			deliveryId: chargedDelivery.deliveryId,
			resource: 'email_receives_per_day',
			day: chargedDelivery.quotaDay,
			limit: chargeInput.limit,
			updatedAt,
		})
		if (meterResult.outcome === 'needs_bootstrap') {
			await meter.initialize({
				resource: 'email_receives_per_day',
				day: chargedDelivery.quotaDay,
				count: 0,
				updatedAt,
			})
			meterResult = await meter.consumeInboundDelivery({
				deliveryId: chargedDelivery.deliveryId,
				resource: 'email_receives_per_day',
				day: chargedDelivery.quotaDay,
				limit: chargeInput.limit,
				updatedAt,
			})
			if (meterResult.outcome === 'needs_bootstrap') {
				throw new Error(
					'UserMeter inbound delivery consume still needs bootstrap after initialize.',
				)
			}
		}
		if (!meterResult.consumed && !meterResult.replayed) {
			throw new EntitlementLimitError({
				resource: 'email_receives_per_day',
				plan: chargeInput.plan,
				limit: chargeInput.limit,
				current: meterResult.count,
				upgradeHint: buildEntitlementUpgradeHint('email_receives_per_day'),
			})
		}
		const result = await mailbox.insertChargedPendingInboundDelivery({
			ownerId: userId,
			delivery: toInsertInput(chargedDelivery),
			now: updatedAt,
		})
		const delivery = await mirror(result.delivery)
		return {
			delivery,
			charged:
				result.status === 'inserted' &&
				claimedDelivery.deliveryId === chargeInput.delivery.deliveryId,
		}
	}
	return {
		get,
		getWindow,
		claimWindow,
		charge,
		async claimStorage(
			delivery: InboundDelivery,
			expectedAttachmentCount: number,
			usageStartedAt?: string,
			now = new Date(),
		) {
			const result = await mailbox.claimInboundDeliveryStorage({
				ownerId: userId,
				deliveryId: delivery.deliveryId,
				expectedAttachmentCount,
				usageStartedAt,
				now: now.toISOString(),
			})
			if (result.status === 'claimed') {
				const storageLease = result.delivery.storageLease
				if (!storageLease) {
					throw new Error(
						'Mailbox returned a claimed inbound storage delivery without a lease.',
					)
				}
				let projected: InboundDelivery
				try {
					projected = await mirror(result.delivery)
				} catch (projectionError) {
					let compensationError: unknown
					try {
						await mailbox.releaseInboundDeliveryStorage({
							ownerId: userId,
							deliveryId: result.delivery.deliveryId,
							storageLease,
							now: now.toISOString(),
						})
					} catch (error) {
						compensationError = error
					}
					if (compensationError) {
						throw new AggregateError(
							[projectionError, compensationError],
							'Inbound storage claim projection failed and its Mailbox lease could not be released.',
						)
					}
					throw projectionError
				}
				return {
					claimed: true as const,
					delivery: projected,
				}
			}
			return {
				claimed: false as const,
				delivery: result.delivery ? await mirror(result.delivery) : null,
			}
		},
		async releaseStorage(delivery: InboundDelivery, now = new Date()) {
			if (!delivery.storageLease) return
			const result = await mailbox.releaseInboundDeliveryStorage({
				ownerId: userId,
				deliveryId: delivery.deliveryId,
				storageLease: delivery.storageLease,
				now: now.toISOString(),
			})
			if (result.status === 'released') await mirror(result.delivery)
		},
		async reject(delivery: InboundDelivery, reason: string, now = new Date()) {
			const result = await mailbox.markInboundDeliveryRejected({
				ownerId: userId,
				deliveryId: delivery.deliveryId,
				reason,
				expectedStorageLease: delivery.storageLease,
				expectedState: delivery.state,
				now: now.toISOString(),
			})
			if (
				result.status === 'rejected' ||
				result.status === 'already-rejected'
			) {
				const canonical = toUserInboundDelivery(userId, result.delivery)
				try {
					return await mirror(result.delivery)
				} catch (error) {
					console.warn(
						'inbound-email-rejected-projection-failed',
						userId,
						result.delivery.deliveryId,
						error,
					)
					return canonical
				}
			}
			if (result.status === 'already-received') {
				await mirror(result.delivery)
				return null
			}
			throw new InboundDeliveryLeaseLostError(
				'Inbound rejection lost a state race; delivery should be retried.',
			)
		},
		async receive(input: UserInboundDeliveryReceiveInput) {
			if (!input.delivery.storageLease) {
				throw new InboundDeliveryLeaseLostError(
					'Inbound delivery finalization requires a storage lease.',
				)
			}
			const result = await mailbox.markInboundDeliveryReceived({
				ownerId: userId,
				deliveryId: input.delivery.deliveryId,
				storageLease: input.delivery.storageLease,
				usageDurationMs: input.usageDurationMs,
				usageMonth: input.usageMonth,
				usageBytes: input.usageBytes,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (
				result.status === 'received' ||
				result.status === 'already-received'
			) {
				return await mirror(result.delivery)
			}
			throw new InboundDeliveryLeaseLostError(
				'Inbound delivery storage lease was lost before finalization.',
			)
		},
		async deferReconciliation(deliveryId: string, now = new Date()) {
			const result = await mailbox.deferInboundDeliveryReconciliation({
				ownerId: userId,
				deliveryId,
				now: now.toISOString(),
			})
			if (result.status === 'deferred') await mirror(result.delivery)
			return result
		},
		async listDueStale(now = new Date(), limit?: number) {
			return await mailbox.listDueStaleInboundDeliveries({
				ownerId: userId,
				now: now.toISOString(),
				limit,
			})
		},
		async claimCleanup(input: UserInboundDeliveryCleanupClaimInput) {
			const now = input.now ?? new Date()
			const result = await mailbox.claimInboundDeliveryCleanup({
				ownerId: userId,
				deliveryId: input.deliveryId,
				expectedState: input.expectedState,
				expectedUpdatedAt: input.expectedUpdatedAt,
				staleBefore: input.staleBefore.toISOString(),
				now: now.toISOString(),
			})
			if (result.status === 'claimed') {
				const cleanupLease = result.delivery.cleanupLease
				if (!cleanupLease) {
					throw new Error(
						'Mailbox returned a claimed inbound cleanup delivery without a lease.',
					)
				}
				try {
					await mirror(result.delivery)
				} catch (projectionError) {
					let compensationError: unknown
					try {
						await mailbox.releaseInboundDeliveryCleanup({
							ownerId: userId,
							deliveryId: result.delivery.deliveryId,
							cleanupLease,
							now: now.toISOString(),
						})
					} catch (error) {
						compensationError = error
					}
					if (compensationError) {
						throw new AggregateError(
							[projectionError, compensationError],
							'Inbound cleanup claim projection failed and its Mailbox lease could not be released.',
						)
					}
					throw projectionError
				}
			} else if (result.delivery) {
				await mirror(result.delivery)
			}
			return result
		},
		async releaseCleanup(
			deliveryId: string,
			cleanupLease: string,
			now = new Date(),
		) {
			const result = await mailbox.releaseInboundDeliveryCleanup({
				ownerId: userId,
				deliveryId,
				cleanupLease,
				now: now.toISOString(),
			})
			if (result.status === 'released') await mirror(result.delivery)
			return result
		},
		async markOrphanCleaned(input: UserInboundDeliveryOrphanCleanedInput) {
			const result = await mailbox.markInboundDeliveryOrphanCleaned({
				ownerId: userId,
				deliveryId: input.deliveryId,
				cleanupLease: input.cleanupLease,
				outcome: input.outcome,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (result.status === 'orphan-cleaned') await mirror(result.delivery)
			return result
		},
		async pruneExpiredDedupe(now = new Date(), limit?: number) {
			const result = await mailbox.pruneExpiredInboundDedupePointers({
				ownerId: userId,
				now: now.toISOString(),
				limit,
			})
			if (result.prunedEventIds.length === 0) return 0
			const placeholders = result.prunedEventIds.map(() => '?').join(', ')
			await env.APP_DB.prepare(
				`DELETE FROM email_delivery_events
				WHERE user_id = ?
					AND provider = ?
					AND id IN (${placeholders})`,
			)
				.bind(userId, mailboxInboundDedupeProvider, ...result.prunedEventIds)
				.run()
			return result.pruned
		},
		async claimUsageEffect(input: UserInboundUsageEffectClaimInput) {
			const result = await mailbox.claimInboundUsageEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				expectedFinalizationToken: input.expectedFinalizationToken,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (result.status === 'claimed') {
				await mirrorClaimBestEffort(
					result.delivery,
					'inbound-email-usage-effect-claim-projection-failed',
				)
			} else if (result.delivery) {
				await mirror(result.delivery)
			}
			return result
		},
		async completeUsageEffect(input: UserInboundUsageEffectCompleteInput) {
			const result = await mailbox.completeInboundUsageEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				usageEffectLease: input.usageEffectLease,
				expectedFinalizationToken: input.expectedFinalizationToken,
				mode: input.mode,
				usageMonth: input.usageMonth,
				usageBytes: input.usageBytes,
				usageDurationMs: input.usageDurationMs,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (result.status !== 'lease-lost') await mirror(result.delivery)
			return result
		},
		async claimSubscriptionEffect(
			input: UserInboundSubscriptionEffectClaimInput,
		) {
			const result = await mailbox.claimInboundSubscriptionEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				expectedFinalizationToken: input.expectedFinalizationToken,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (result.status === 'claimed') {
				await mirrorClaimBestEffort(
					result.delivery,
					'inbound-email-subscription-effect-claim-projection-failed',
				)
			} else if (result.delivery) {
				await mirror(result.delivery)
			}
			return result
		},
		async completeSubscriptionEffect(
			input: UserInboundSubscriptionEffectCompleteInput,
		) {
			const result = await mailbox.completeInboundSubscriptionEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				subscriptionEffectLease: input.subscriptionEffectLease,
				expectedFinalizationToken: input.expectedFinalizationToken,
				mode: input.mode,
				suppressionReason: input.suppressionReason,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (result.status !== 'lease-lost') await mirror(result.delivery)
			return result
		},
		async failSubscriptionEffect(
			input: UserInboundSubscriptionEffectFailInput,
		) {
			const result = await mailbox.failInboundSubscriptionEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				subscriptionEffectLease: input.subscriptionEffectLease,
				expectedFinalizationToken: input.expectedFinalizationToken,
				error: input.error,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (result.status !== 'lease-lost') await mirror(result.delivery)
			return result
		},
		async listDueEffects(now = new Date(), limit?: number) {
			return await mailbox.listDueInboundEffectWork({
				ownerId: userId,
				now: now.toISOString(),
				limit,
			})
		},
	} satisfies UserInboundDeliveryAuthority
}
