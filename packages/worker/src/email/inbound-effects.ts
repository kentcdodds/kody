import { getInboundDelivery } from './inbound-delivery.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { createUserInboundDeliveryAuthority } from './inbound-delivery-authority.ts'
import {
	dispatchInboundEmailSubscriptionEvents,
	dispatchSystemInboundEmailSubscriptionEvents,
} from './package-subscriptions.ts'
import { getInternalEmailMessageById } from './mailbox-internal-read.ts'
import { systemEmailOwnerId } from './email-owner.ts'

const subscriptionEffectLeaseMs = 5 * 60 * 1000
const effectRetryMs = 15 * 60 * 1000
const maxSubscriptionEffectAttempts = 3

export function resolveSubscriptionEffectFailure(attemptCount: number) {
	const nextAttempt = Math.max(0, Math.floor(attemptCount)) + 1
	return {
		attemptCount: nextAttempt,
		deadLettered: nextAttempt >= maxSubscriptionEffectAttempts,
	}
}

type InboundEffectsEnv = Pick<
	Env,
	| 'APP_DB'
	| 'BUNDLE_ARTIFACTS_KV'
	| 'APP_BASE_URL'
	| 'USAGE_EVENTS'
	| 'MAILBOX'
	| 'USER_METER'
>

async function recordInboundUsageEffect(input: {
	env: InboundEffectsEnv
	userId: string
	deliveryId: string
	usageMonth: string
	usageBytes: number
	expectedFinalizationToken?: string
	durationMs?: number
	now: Date
}) {
	const finalizationToken = input.expectedFinalizationToken ?? null
	if (!input.env.USAGE_EVENTS) {
		const month = input.usageMonth
		try {
			await input.env.APP_DB.batch([
				input.env.APP_DB.prepare(
					`INSERT INTO usage_rollups (
						user_id, metric, month, event_count, error_count,
						total_duration_ms, total_cpu_ms, total_bytes, updated_at
					)
					SELECT ?, 'email_received', ?, 1, 0, ?, 0, ?, ?
					WHERE EXISTS (
						SELECT 1 FROM email_delivery_events
						WHERE id = ?
							AND user_id = ?
							AND event_type = 'received'
							AND json_extract(detail_json, '$.usageEffectRecordedAt') IS NULL
							AND json_extract(detail_json, '$.usageEffectSuppressedAt') IS NULL
							AND (
								json_extract(detail_json, '$.usageEffectRetryAt') IS NULL
								OR json_extract(detail_json, '$.usageEffectRetryAt') <= ?
							)
							AND (? IS NULL OR json_extract(detail_json, '$.finalizationToken') = ?)
					)
					ON CONFLICT (user_id, metric, month) DO UPDATE SET
						event_count = event_count + 1,
						total_duration_ms = total_duration_ms + excluded.total_duration_ms,
						total_bytes = total_bytes + excluded.total_bytes,
						updated_at = excluded.updated_at`,
				).bind(
					input.userId,
					month,
					Math.round(input.durationMs ?? 0),
					Math.round(input.usageBytes),
					input.now.toISOString(),
					input.deliveryId,
					input.userId,
					input.now.toISOString(),
					finalizationToken,
					finalizationToken,
				),
				input.env.APP_DB.prepare(
					`UPDATE email_delivery_events
					SET
						detail_json = json_remove(
							json_set(
								detail_json,
								'$.usageEffectRecordedAt', ?,
								'$.usageMonth', ?,
								'$.usageBytes', ?,
								'$.usageDurationMs', ?
							),
							'$.usageEffectRetryAt'
						),
						usage_effect_recorded_at = ?,
						usage_month = ?,
						usage_bytes = ?,
						usage_duration_ms = ?,
						needs_effect_reconcile = CASE
							WHEN json_extract(
								detail_json,
								'$.subscriptionEffectState'
							) IN ('complete', 'dead-letter')
							THEN 0
							ELSE 1
						END
					WHERE id = ?
						AND user_id = ?
						AND event_type = 'received'
						AND json_extract(detail_json, '$.usageEffectRecordedAt') IS NULL
						AND json_extract(detail_json, '$.usageEffectSuppressedAt') IS NULL
						AND (
							json_extract(detail_json, '$.usageEffectRetryAt') IS NULL
							OR json_extract(detail_json, '$.usageEffectRetryAt') <= ?
						)
						AND (? IS NULL OR json_extract(detail_json, '$.finalizationToken') = ?)`,
				).bind(
					input.now.toISOString(),
					month,
					Math.round(input.usageBytes),
					Math.round(input.durationMs ?? 0),
					input.now.toISOString(),
					month,
					Math.round(input.usageBytes),
					Math.round(input.durationMs ?? 0),
					input.deliveryId,
					input.userId,
					input.now.toISOString(),
					finalizationToken,
					finalizationToken,
				),
			])
			return
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes('no such table: usage_rollups')
			) {
				throw error
			}
			// Minimal email schemas intentionally omit local rollups. Preserve
			// best-effort metering semantics without poisoning the outbox.
			await input.env.APP_DB.prepare(
				`UPDATE email_delivery_events
				SET
					detail_json = json_set(
						detail_json,
						'$.usageEffectRecordedAt', ?,
						'$.usageMonth', ?,
						'$.usageBytes', ?,
						'$.usageDurationMs', ?
					),
					usage_effect_recorded_at = ?,
					usage_month = ?,
					usage_bytes = ?,
					usage_duration_ms = ?,
					needs_effect_reconcile = CASE
						WHEN json_extract(
							detail_json,
							'$.subscriptionEffectState'
						) IN ('complete', 'dead-letter')
						THEN 0
						ELSE 1
					END
				WHERE id = ?
					AND user_id = ?
					AND event_type = 'received'
					AND json_extract(detail_json, '$.usageEffectRecordedAt') IS NULL
					AND json_extract(detail_json, '$.usageEffectSuppressedAt') IS NULL
					AND (? IS NULL OR json_extract(detail_json, '$.finalizationToken') = ?)`,
			)
				.bind(
					input.now.toISOString(),
					month,
					Math.round(input.usageBytes),
					Math.round(input.durationMs ?? 0),
					input.now.toISOString(),
					month,
					Math.round(input.usageBytes),
					Math.round(input.durationMs ?? 0),
					input.deliveryId,
					input.userId,
					finalizationToken,
					finalizationToken,
				)
				.run()
			return
		}
	}
	await input.env.APP_DB.prepare(
		`UPDATE email_delivery_events
		SET
			detail_json = json_remove(
				json_set(
					detail_json,
					'$.usageEffectRecordedAt', ?,
					'$.usageMonth', ?,
					'$.usageBytes', ?,
					'$.usageDurationMs', ?
				),
				'$.usageEffectRetryAt'
			),
			usage_effect_recorded_at = ?,
			usage_month = ?,
			usage_bytes = ?,
			usage_duration_ms = ?,
			needs_effect_reconcile = CASE
				WHEN json_extract(
					detail_json,
					'$.subscriptionEffectState'
				) IN ('complete', 'dead-letter')
				THEN 0
				ELSE 1
			END
		WHERE id = ?
			AND user_id = ?
			AND event_type = 'received'
			AND json_extract(detail_json, '$.usageEffectRecordedAt') IS NULL
			AND json_extract(detail_json, '$.usageEffectSuppressedAt') IS NULL
			AND (? IS NULL OR json_extract(detail_json, '$.finalizationToken') = ?)`,
	)
		.bind(
			input.now.toISOString(),
			input.usageMonth,
			Math.round(input.usageBytes),
			Math.round(input.durationMs ?? 0),
			input.now.toISOString(),
			input.usageMonth,
			Math.round(input.usageBytes),
			Math.round(input.durationMs ?? 0),
			input.deliveryId,
			input.userId,
			finalizationToken,
			finalizationToken,
		)
		.run()
}

async function recordUserInboundUsageRollup(input: {
	env: InboundEffectsEnv
	userId: string
	deliveryId: string
	finalizationToken: string
	usageMonth: string
	usageBytes: number
	usageDurationMs: number
	now: Date
}) {
	if (input.env.USAGE_EVENTS) return
	try {
		await input.env.APP_DB.batch([
			input.env.APP_DB.prepare(
				`INSERT INTO usage_rollups (
					user_id, metric, month, event_count, error_count,
					total_duration_ms, total_cpu_ms, total_bytes, updated_at
				)
				SELECT ?, 'email_received', ?, 1, 0, ?, 0, ?, ?
				WHERE NOT EXISTS (
					SELECT 1 FROM email_inbound_usage_effects
					WHERE user_id = ? AND delivery_id = ? AND finalization_token = ?
				)
				ON CONFLICT (user_id, metric, month) DO UPDATE SET
					event_count = event_count + 1,
					total_duration_ms = total_duration_ms + excluded.total_duration_ms,
					total_bytes = total_bytes + excluded.total_bytes,
					updated_at = excluded.updated_at`,
			).bind(
				input.userId,
				input.usageMonth,
				Math.round(input.usageDurationMs),
				Math.round(input.usageBytes),
				input.now.toISOString(),
				input.userId,
				input.deliveryId,
				input.finalizationToken,
			),
			input.env.APP_DB.prepare(
				`INSERT OR IGNORE INTO email_inbound_usage_effects (
					user_id, delivery_id, finalization_token, created_at
				) VALUES (?, ?, ?, ?)`,
			).bind(
				input.userId,
				input.deliveryId,
				input.finalizationToken,
				input.now.toISOString(),
			),
		])
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!error.message.includes('no such table: usage_rollups')
		) {
			throw error
		}
	}
}

async function processUserInboundDeliveryEffectsWithLeaseHeld(input: {
	env: InboundEffectsEnv
	userId: string
	deliveryId: string
	expectedFinalizationToken?: string
	durationMs?: number
	now?: Date
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const now = input.now ?? new Date()
	const authority = createUserInboundDeliveryAuthority({
		env: input.env,
		userId: input.userId,
	})
	const delivery = await authority.get(input.deliveryId)
	if (
		delivery?.state !== 'received' ||
		!delivery.finalizationToken ||
		(input.expectedFinalizationToken != null &&
			delivery.finalizationToken !== input.expectedFinalizationToken)
	) {
		return { outcome: 'stale' as const }
	}
	const message = await getInternalEmailMessageById({
		env: input.env,
		ownerId: input.userId,
		messageId: delivery.messageId,
	})
	const usageMonth =
		delivery.usageMonth ??
		(message
			? (message.receivedAt ?? message.createdAt).slice(0, 7)
			: now.toISOString().slice(0, 7))
	const usageBytes = delivery.usageBytes ?? message?.rawSize ?? 0
	const usageDurationMs = delivery.usageDurationMs ?? input.durationMs ?? 0
	const usageClaim = await authority.claimUsageEffect({
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: delivery.finalizationToken,
		now,
	})
	if (usageClaim.status === 'claimed') {
		await recordUserInboundUsageRollup({
			env: input.env,
			userId: input.userId,
			deliveryId: delivery.deliveryId,
			finalizationToken: delivery.finalizationToken,
			usageMonth,
			usageBytes,
			usageDurationMs,
			now,
		})
		const completed = await authority.completeUsageEffect({
			deliveryId: delivery.deliveryId,
			usageEffectLease: usageClaim.delivery.usageEffectLease!,
			expectedFinalizationToken: delivery.finalizationToken,
			mode: 'recorded',
			usageMonth,
			usageBytes,
			usageDurationMs,
			now,
		})
		if (completed.status === 'lease-lost') {
			return { outcome: 'stale' as const }
		}
	}

	const subscriptionClaim = await authority.claimSubscriptionEffect({
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: delivery.finalizationToken,
		now,
	})
	if (subscriptionClaim.status !== 'claimed') {
		return { outcome: 'usage-only' as const }
	}
	const effectLease = subscriptionClaim.delivery.subscriptionEffectLease!
	try {
		if (!message) {
			await authority.completeSubscriptionEffect({
				deliveryId: delivery.deliveryId,
				subscriptionEffectLease: effectLease,
				expectedFinalizationToken: delivery.finalizationToken,
				mode: 'suppressed',
				suppressionReason: 'missing-message',
				now,
			})
			return { outcome: 'missing-message' as const }
		}
		await dispatchInboundEmailSubscriptionEvents({
			env: input.env,
			userId: input.userId,
			message,
			waitUntil: input.waitUntil,
		})
		const completed = await authority.completeSubscriptionEffect({
			deliveryId: delivery.deliveryId,
			subscriptionEffectLease: effectLease,
			expectedFinalizationToken: delivery.finalizationToken,
			mode: 'complete',
			now,
		})
		if (completed.status === 'lease-lost') {
			return { outcome: 'stale' as const }
		}
		return { outcome: 'complete' as const }
	} catch (error) {
		const failure = await authority.failSubscriptionEffect({
			deliveryId: delivery.deliveryId,
			subscriptionEffectLease: effectLease,
			expectedFinalizationToken: delivery.finalizationToken,
			error: error instanceof Error ? error.message : String(error),
			now,
		})
		if (failure.status === 'lease-lost') {
			return { outcome: 'stale' as const }
		}
		if (failure.status === 'dead-letter') {
			console.error('inbound-email-subscription-effect-dead-lettered', {
				userId: input.userId,
				deliveryId: delivery.deliveryId,
				attemptCount: failure.delivery.subscriptionEffectAttemptCount,
				error,
			})
			return { outcome: 'dead-letter' as const }
		}
		throw error
	}
}

export type ProcessInboundDeliveryEffectsInput = {
	env: InboundEffectsEnv
	userId: string
	deliveryId: string
	expectedFinalizationToken?: string
	durationMs?: number
	now?: Date
	waitUntil?: (promise: Promise<unknown>) => void
}

// system:email deliberately retains the legacy D1 authority and effect policy;
// USER deliveries use the Mailbox CAS engine below. Keep the split explicit.
async function processSystemInboundDeliveryEffectsWithLeaseHeld(
	input: ProcessInboundDeliveryEffectsInput,
) {
	const now = input.now ?? new Date()
	const delivery = await getInboundDelivery({
		db: input.env.APP_DB,
		userId: input.userId,
		deliveryId: input.deliveryId,
	})
	if (
		delivery?.state !== 'received' ||
		(input.expectedFinalizationToken != null &&
			delivery.finalizationToken !== input.expectedFinalizationToken)
	) {
		return { outcome: 'stale' as const }
	}
	const finalizationToken = delivery.finalizationToken
	const message = await getInternalEmailMessageById({
		env: input.env,
		ownerId: input.userId,
		messageId: delivery.messageId,
	})

	await recordInboundUsageEffect({
		env: input.env,
		userId: input.userId,
		deliveryId: delivery.deliveryId,
		usageMonth:
			delivery.usageMonth ??
			(message
				? (message.receivedAt ?? message.createdAt).slice(0, 7)
				: now.toISOString().slice(0, 7)),
		usageBytes: delivery.usageBytes ?? message?.rawSize ?? 0,
		expectedFinalizationToken: finalizationToken,
		durationMs: delivery.usageDurationMs ?? input.durationMs,
		now,
	})
	if (!message) {
		await input.env.APP_DB.prepare(
			`UPDATE email_delivery_events
			SET
				detail_json = json_set(
					detail_json,
					'$.subscriptionEffectState', 'complete',
					'$.subscriptionEffectMissingMessageAt', ?
				),
				needs_effect_reconcile = CASE
					WHEN usage_effect_recorded_at IS NOT NULL
						OR json_extract(
							detail_json,
							'$.usageEffectSuppressedAt'
						) IS NOT NULL
					THEN 0
					ELSE 1
				END
			WHERE id = ?
				AND user_id = ?
				AND event_type = 'received'
				AND json_extract(
					detail_json,
					'$.subscriptionEffectState'
				) NOT IN ('complete', 'dead-letter')
				AND json_extract(detail_json, '$.finalizationToken') = ?`,
		)
			.bind(
				now.toISOString(),
				delivery.deliveryId,
				input.userId,
				finalizationToken,
			)
			.run()
		return { outcome: 'missing-message' as const }
	}

	const effectLease = crypto.randomUUID()
	const effectLeaseAt = now.toISOString()
	const expiredBefore = new Date(
		now.getTime() - subscriptionEffectLeaseMs,
	).toISOString()
	const subscriptionClaim = await input.env.APP_DB.prepare(
		`UPDATE email_delivery_events
		SET detail_json = json_set(
			detail_json,
			'$.subscriptionEffectState', 'processing',
			'$.subscriptionEffectLease', ?,
			'$.subscriptionEffectLeaseAt', ?
		)
		WHERE id = ?
			AND user_id = ?
			AND event_type = 'received'
			AND (? IS NULL OR json_extract(detail_json, '$.finalizationToken') = ?)
			AND (
				json_extract(detail_json, '$.subscriptionEffectRetryAt') IS NULL
				OR json_extract(detail_json, '$.subscriptionEffectRetryAt') <= ?
			)
			AND (
				json_extract(detail_json, '$.subscriptionEffectState') IS NULL
				OR json_extract(detail_json, '$.subscriptionEffectState') = 'pending'
				OR (
					json_extract(detail_json, '$.subscriptionEffectState') = 'processing'
					AND json_extract(detail_json, '$.subscriptionEffectLeaseAt') < ?
				)
			)`,
	)
		.bind(
			effectLease,
			effectLeaseAt,
			delivery.deliveryId,
			input.userId,
			finalizationToken ?? null,
			finalizationToken ?? null,
			now.toISOString(),
			expiredBefore,
		)
		.run()
	if (Number(subscriptionClaim.meta.changes ?? 0) === 0) {
		return { outcome: 'usage-only' as const }
	}
	try {
		if (
			input.userId === systemEmailOwnerId &&
			message.classification === 'quarantined'
		) {
			await input.env.APP_DB.prepare(
				`UPDATE email_delivery_events
				SET
					detail_json = json_remove(
						json_remove(
							json_remove(
								json_set(
									detail_json,
									'$.subscriptionEffectState', 'complete',
									'$.subscriptionEffectSuppressedQuarantineAt', ?
								),
								'$.subscriptionEffectLease'
							),
							'$.subscriptionEffectLeaseAt'
						),
						'$.subscriptionEffectRetryAt'
					),
					needs_effect_reconcile = CASE
						WHEN usage_effect_recorded_at IS NOT NULL
							OR json_extract(
								detail_json,
								'$.usageEffectSuppressedAt'
							) IS NOT NULL
						THEN 0
						ELSE 1
					END
				WHERE id = ?
					AND user_id = ?
					AND json_extract(detail_json, '$.subscriptionEffectLease') = ?`,
			)
				.bind(now.toISOString(), delivery.deliveryId, input.userId, effectLease)
				.run()
			return { outcome: 'complete' as const }
		}
		if (input.userId === systemEmailOwnerId) {
			await dispatchSystemInboundEmailSubscriptionEvents({
				env: input.env,
				message,
				waitUntil: input.waitUntil,
			})
		} else {
			await dispatchInboundEmailSubscriptionEvents({
				env: input.env,
				userId: input.userId,
				message,
				waitUntil: input.waitUntil,
			})
		}
		await input.env.APP_DB.prepare(
			`UPDATE email_delivery_events
			SET
				detail_json = json_remove(
					json_remove(
						json_remove(
							json_set(detail_json, '$.subscriptionEffectState', 'complete'),
							'$.subscriptionEffectLease'
						),
						'$.subscriptionEffectLeaseAt'
					),
					'$.subscriptionEffectRetryAt'
				),
				needs_effect_reconcile = CASE
					WHEN usage_effect_recorded_at IS NOT NULL
						OR json_extract(
							detail_json,
							'$.usageEffectSuppressedAt'
						) IS NOT NULL
					THEN 0
					ELSE 1
				END
			WHERE id = ?
				AND user_id = ?
				AND json_extract(detail_json, '$.subscriptionEffectLease') = ?`,
		)
			.bind(delivery.deliveryId, input.userId, effectLease)
			.run()
		return { outcome: 'complete' as const }
	} catch (error) {
		const failure = resolveSubscriptionEffectFailure(
			delivery.subscriptionEffectAttemptCount ?? 0,
		)
		const nextAttempt = failure.attemptCount
		const deadLettered = failure.deadLettered
		await input.env.APP_DB.prepare(
			`UPDATE email_delivery_events
			SET
				detail_json = json_remove(
					json_remove(
						json_set(
							detail_json,
							'$.subscriptionEffectState', ?,
							'$.subscriptionEffectRetryAt', ?,
							'$.subscriptionEffectAttemptCount', ?,
							'$.subscriptionEffectLastError', ?,
							'$.subscriptionEffectDeadLetterAt', ?
						),
						'$.subscriptionEffectLease'
					),
					'$.subscriptionEffectLeaseAt'
				),
				needs_effect_reconcile = CASE
					WHEN ?
						AND (
							usage_effect_recorded_at IS NOT NULL
							OR json_extract(
								detail_json,
								'$.usageEffectSuppressedAt'
							) IS NOT NULL
						)
					THEN 0
					ELSE 1
				END
			WHERE id = ?
				AND user_id = ?
				AND json_extract(detail_json, '$.subscriptionEffectLease') = ?`,
		)
			.bind(
				deadLettered ? 'dead-letter' : 'pending',
				deadLettered
					? null
					: new Date(now.getTime() + effectRetryMs).toISOString(),
				nextAttempt,
				error instanceof Error ? error.message : String(error),
				deadLettered ? now.toISOString() : null,
				deadLettered,
				delivery.deliveryId,
				input.userId,
				effectLease,
			)
			.run()
		if (deadLettered) {
			console.error('inbound-email-subscription-effect-dead-lettered', {
				userId: input.userId,
				deliveryId: delivery.deliveryId,
				attemptCount: nextAttempt,
				error,
			})
			return { outcome: 'dead-letter' as const }
		}
		throw error
	}
}

export async function processInboundDeliveryEffects(
	input: ProcessInboundDeliveryEffectsInput,
) {
	if (input.userId === systemEmailOwnerId) {
		return await processSystemInboundDeliveryEffectsWithLeaseHeld(input)
	}
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		write: async () =>
			await processUserInboundDeliveryEffectsWithLeaseHeld(input),
	})
}

export async function reconcileInboundDeliveryEffectsForUser(input: {
	env: InboundEffectsEnv
	userId: string
	now?: Date
	limit?: number
}) {
	const now = input.now ?? new Date()
	if (input.userId !== systemEmailOwnerId) {
		const authority = createUserInboundDeliveryAuthority({
			env: input.env,
			userId: input.userId,
		})
		const bridgeRows = await input.env.APP_DB.prepare(
			`SELECT id FROM email_delivery_events
			WHERE user_id = ?
				AND provider = 'cloudflare-email-routing'
				AND event_type = 'received'
				AND needs_effect_reconcile = 1
			ORDER BY created_at ASC, id ASC
			LIMIT ?`,
		)
			.bind(input.userId, input.limit ?? 20)
			.all<{ id: string }>()
		let processed = 0
		let errors = 0
		for (const row of bridgeRows.results ?? []) {
			try {
				await authority.get(row.id)
			} catch (error) {
				errors += 1
				console.warn(
					'inbound-email-effect-bridge-failed',
					input.userId,
					row.id,
					error,
				)
			}
		}
		const due = await authority.listDueEffects(now, input.limit)
		for (const delivery of due.deliveries) {
			try {
				await processInboundDeliveryEffects({
					env: input.env,
					userId: input.userId,
					deliveryId: delivery.deliveryId,
					now: input.now,
				})
				processed += 1
			} catch (error) {
				errors += 1
				console.warn(
					'inbound-email-effect-reconciliation-failed',
					input.userId,
					delivery.deliveryId,
					error,
				)
			}
		}
		return { processed, errors }
	}
	const leaseExpiredBefore = new Date(
		now.getTime() - subscriptionEffectLeaseMs,
	).toISOString()
	const rows = await input.env.APP_DB.prepare(
		`SELECT id
		FROM email_delivery_events
		WHERE user_id = ?
			AND provider = 'cloudflare-email-routing'
			AND event_type = 'received'
			AND needs_effect_reconcile = 1
			AND json_extract(detail_json, '$.fingerprint') IS NOT NULL
			AND (
				(
					json_extract(detail_json, '$.usageEffectRecordedAt') IS NULL
					AND json_extract(detail_json, '$.usageEffectSuppressedAt') IS NULL
					AND (
						json_extract(detail_json, '$.usageEffectRetryAt') IS NULL
						OR json_extract(detail_json, '$.usageEffectRetryAt') <= ?
					)
					AND (
						json_extract(detail_json, '$.usageEffectLease') IS NULL
						OR json_extract(detail_json, '$.usageEffectLeaseAt') < ?
					)
				)
				OR (
					(
						json_extract(detail_json, '$.subscriptionEffectState') IS NULL
						OR json_extract(
							detail_json,
							'$.subscriptionEffectState'
						) NOT IN ('complete', 'dead-letter')
					)
					AND (
						json_extract(detail_json, '$.subscriptionEffectRetryAt') IS NULL
						OR json_extract(detail_json, '$.subscriptionEffectRetryAt') <= ?
					)
					AND (
						json_extract(detail_json, '$.subscriptionEffectState') != 'processing'
						OR json_extract(detail_json, '$.subscriptionEffectLeaseAt') < ?
					)
				)
			)
		ORDER BY COALESCE(
			json_extract(detail_json, '$.usageEffectRetryAt'),
			json_extract(detail_json, '$.subscriptionEffectRetryAt'),
			created_at
		) ASC, id ASC
		LIMIT ?`,
	)
		.bind(
			input.userId,
			now.toISOString(),
			leaseExpiredBefore,
			now.toISOString(),
			leaseExpiredBefore,
			input.limit ?? 20,
		)
		.all<{ id: string }>()
	let processed = 0
	let errors = 0
	for (const row of rows.results ?? []) {
		try {
			await processInboundDeliveryEffects({
				env: input.env,
				userId: input.userId,
				deliveryId: row.id,
				now: input.now,
			})
			processed += 1
		} catch (error) {
			errors += 1
			console.warn(
				'inbound-email-effect-reconciliation-failed',
				input.userId,
				row.id,
				error,
			)
		}
	}
	return { processed, errors }
}
