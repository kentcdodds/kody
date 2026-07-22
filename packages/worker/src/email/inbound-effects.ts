import { recordUsage } from '#worker/usage/record-usage.ts'
import { getInboundDelivery } from './inbound-delivery.ts'
import {
	dispatchInboundEmailSubscriptionEvents,
	dispatchSystemInboundEmailSubscriptionEvents,
} from './package-subscriptions.ts'
import { getEmailMessageById } from './repo.ts'
import { systemEmailOwnerId } from './system-email.ts'

const subscriptionEffectLeaseMs = 5 * 60 * 1000

type InboundEffectsEnv = Pick<
	Env,
	'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL' | 'USAGE_EVENTS'
>

export async function processInboundDeliveryEffects(input: {
	env: InboundEffectsEnv
	userId: string
	deliveryId: string
	expectedFinalizationToken?: string
	durationMs?: number
	now?: Date
}) {
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
	const message = await getEmailMessageById({
		db: input.env.APP_DB,
		userId: input.userId,
		messageId: delivery.messageId,
	})
	if (!message) return { outcome: 'missing-message' as const }

	const usageClaim = await input.env.APP_DB.prepare(
		`UPDATE email_delivery_events
		SET detail_json = json_set(detail_json, '$.usageEffectClaimedAt', ?)
		WHERE id = ?
			AND user_id = ?
			AND event_type = 'received'
			AND json_extract(detail_json, '$.usageEffectClaimedAt') IS NULL
			AND (? IS NULL OR json_extract(detail_json, '$.finalizationToken') = ?)`,
	)
		.bind(
			now.toISOString(),
			delivery.deliveryId,
			input.userId,
			input.expectedFinalizationToken ?? null,
			input.expectedFinalizationToken ?? null,
		)
		.run()
	if (Number(usageClaim.meta.changes ?? 0) > 0) {
		await recordUsage(input.env, {
			userId: input.userId,
			eventType: 'email_received',
			entityId: message.id,
			bytes: message.rawSize,
			durationMs: input.durationMs ?? 0,
			outcome: 'success',
			timestamp: message.receivedAt ?? message.createdAt,
		})
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
			input.expectedFinalizationToken ?? null,
			input.expectedFinalizationToken ?? null,
			expiredBefore,
		)
		.run()
	if (Number(subscriptionClaim.meta.changes ?? 0) === 0) {
		return { outcome: 'usage-only' as const }
	}
	try {
		if (input.userId === systemEmailOwnerId) {
			await dispatchSystemInboundEmailSubscriptionEvents({
				env: input.env,
				message,
			})
		} else {
			await dispatchInboundEmailSubscriptionEvents({
				env: input.env,
				userId: input.userId,
				message,
			})
		}
		await input.env.APP_DB.prepare(
			`UPDATE email_delivery_events
			SET detail_json = json_remove(
				json_remove(
					json_set(detail_json, '$.subscriptionEffectState', 'complete'),
					'$.subscriptionEffectLease'
				),
				'$.subscriptionEffectLeaseAt'
			)
			WHERE id = ?
				AND user_id = ?
				AND json_extract(detail_json, '$.subscriptionEffectLease') = ?`,
		)
			.bind(delivery.deliveryId, input.userId, effectLease)
			.run()
		return { outcome: 'complete' as const }
	} catch (error) {
		await input.env.APP_DB.prepare(
			`UPDATE email_delivery_events
			SET detail_json = json_remove(
				json_remove(
					json_set(detail_json, '$.subscriptionEffectState', 'pending'),
					'$.subscriptionEffectLease'
				),
				'$.subscriptionEffectLeaseAt'
			)
			WHERE id = ?
				AND user_id = ?
				AND json_extract(detail_json, '$.subscriptionEffectLease') = ?`,
		)
			.bind(delivery.deliveryId, input.userId, effectLease)
			.run()
		throw error
	}
}

export async function reconcileInboundDeliveryEffectsForUser(input: {
	env: InboundEffectsEnv
	userId: string
	now?: Date
	limit?: number
}) {
	const rows = await input.env.APP_DB.prepare(
		`SELECT id
		FROM email_delivery_events
		WHERE user_id = ?
			AND provider = 'cloudflare-email-routing'
			AND event_type = 'received'
			AND (
				json_extract(detail_json, '$.usageEffectClaimedAt') IS NULL
				OR json_extract(detail_json, '$.subscriptionEffectState') IS NULL
				OR json_extract(detail_json, '$.subscriptionEffectState') != 'complete'
			)
		ORDER BY created_at ASC, id ASC
		LIMIT ?`,
	)
		.bind(input.userId, input.limit ?? 20)
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
