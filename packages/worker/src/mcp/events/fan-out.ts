import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { type ConnectionProfileGrant } from '#universal/connection-profiles/grants.ts'
import { mcpEventsExtensionFlagKey } from '#universal/feature-flags/registry.ts'
import {
	profileGrantsAllow,
	resolveConnectionProfileGrants,
} from '#worker/connection-profiles/repo.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import { type PackageEventsDispatchQueueMessage } from '#worker/package-events/dispatch-queue-producer.ts'
import { mcpEventDeliveryConcurrency } from './constants.ts'
import {
	buildMcpEventId,
	deliverMcpEventOccurrence,
	serializeMcpEventOccurrence,
	type McpEventOccurrence,
} from './deliver.ts'
import {
	listDeliverableMcpEventSubscriptions,
	readMcpEventSubscriptionSigningSecrets,
	recordMcpEventDeliveryOutcome,
	type McpEventSubscriptionRecord,
} from './subscriptions-repo.ts'

export type McpEventFanOutResult = {
	status:
		| 'skipped_not_mcp'
		| 'no_subscriptions'
		| 'skipped_flag_off'
		| 'fanned_out'
	delivered: number
	failed: number
	/** Subscriptions whose connection profile no longer grants the source package. */
	denied: number
}

async function isMcpEventsExtensionEnabledForUser(input: {
	db: D1Database
	userId: string
}): Promise<boolean> {
	const row = await input.db
		.prepare(`SELECT id FROM users WHERE stable_user_id = ?`)
		.bind(input.userId)
		.first<{ id: number }>()
	if (!row) return false
	return await isFeatureEnabled(input.db, mcpEventsExtensionFlagKey, row.id)
}

/**
 * MCP Events leg of package event delivery. Runs inside the same
 * `kody-package-events-dispatch` consumer message as package subscribers
 * (`deliverPackageEventWithToolFactories`), so there is one dispatch path.
 *
 * Delivery-time re-checks: the emitter declared `mcp: true` (stamped on the
 * message at dispatch), the user still has the flag, the subscription is
 * live and verified, and its connection profile still grants `read` on the
 * emitting package. Per-subscription failures are recorded as `last_error`
 * and never thrown, so a dead callback cannot force a queue redelivery that
 * would replay every other subscriber.
 */
export async function fanOutPackageEventToMcpSubscriptions(input: {
	env: Env
	message: PackageEventsDispatchQueueMessage
	now?: Date
}): Promise<McpEventFanOutResult> {
	const { message } = input
	const result: McpEventFanOutResult = {
		status: 'skipped_not_mcp',
		delivered: 0,
		failed: 0,
		denied: 0,
	}
	if (message.mcp !== true) return result

	const db = input.env.APP_DB
	const now = input.now ?? new Date()
	// Read-only on the hot path: expired rows are filtered here and pruned by
	// events/subscribe, which keeps each principal's row count bounded.
	const subscriptions = await listDeliverableMcpEventSubscriptions({
		db,
		userId: message.userId,
		eventName: message.topic,
		now,
	})
	if (subscriptions.length === 0) {
		result.status = 'no_subscriptions'
		return result
	}

	if (
		!(await isMcpEventsExtensionEnabledForUser({ db, userId: message.userId }))
	) {
		result.status = 'skipped_flag_off'
		return result
	}

	const grantsByProfile = new Map<
		string,
		Promise<ReadonlyArray<ConnectionProfileGrant>>
	>()
	const allowed: Array<McpEventSubscriptionRecord> = []
	for (const subscription of subscriptions) {
		const profileName = subscription.connectionProfileName
		let grants: ReadonlyArray<ConnectionProfileGrant> | null = null
		if (profileName) {
			let pending = grantsByProfile.get(profileName)
			if (!pending) {
				pending = resolveConnectionProfileGrants({
					db,
					userId: message.userId,
					profileName,
				})
				grantsByProfile.set(profileName, pending)
			}
			grants = await pending
		}
		if (
			profileGrantsAllow({
				grants,
				resourceType: 'package',
				resourceId: message.source.packageId,
				action: 'read',
			})
		) {
			allowed.push(subscription)
		} else {
			result.denied += 1
		}
	}

	result.status = 'fanned_out'
	const occurrence: McpEventOccurrence = {
		eventId: await buildMcpEventId({
			sourcePackageId: message.source.packageId,
			topic: message.topic,
			idempotencyKey: message.idempotencyKey,
		}),
		name: message.topic,
		timestamp: message.emittedAt ?? now.toISOString(),
		data: message.payload,
		cursor: null,
	}
	const body = serializeMcpEventOccurrence(occurrence)

	for (const chunk of chunkArray(allowed, mcpEventDeliveryConcurrency)) {
		const settled = await Promise.allSettled(
			chunk.map(async (subscription) => {
				const secrets = await readMcpEventSubscriptionSigningSecrets({
					db,
					env: input.env,
					userId: message.userId,
					id: subscription.id,
					now,
				})
				const delivery = await deliverMcpEventOccurrence({
					subscriptionId: subscription.id,
					callbackUrl: subscription.callbackUrl,
					secrets,
					occurrence,
					body,
				})
				await recordMcpEventDeliveryOutcome({
					db,
					userId: message.userId,
					id: subscription.id,
					now: new Date(),
					outcome: delivery.ok
						? { ok: true }
						: { ok: false, error: delivery.error },
				})
				return delivery
			}),
		)
		for (const [index, settledResult] of settled.entries()) {
			if (settledResult.status === 'fulfilled' && settledResult.value.ok) {
				result.delivered += 1
				continue
			}
			result.failed += 1
			console.warn('mcp-event-delivery-failed', {
				subscriptionId: chunk[index]?.id,
				topic: message.topic,
				eventId: occurrence.eventId,
				...(settledResult.status === 'fulfilled'
					? {
							error: settledResult.value.ok ? null : settledResult.value.error,
							attempts: settledResult.value.attempts,
						}
					: { error: settledResult.reason }),
			})
		}
	}
	return result
}
