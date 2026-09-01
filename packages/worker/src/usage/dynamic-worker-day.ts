import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	userMeterNamespace,
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
import { recordUsage, type UsageEnv } from '#worker/usage/record-usage.ts'

export type DynamicWorkerDayEnv = UsageEnv & UserMeterEnv

/**
 * Record one `dynamic_worker_day` when this user first uses `workerId` on
 * the current UTC day. Cloudflare bills unique Dynamic Worker ids per UTC
 * day, so repeats of the same id must not increment the usage metric.
 *
 * Never throws. Missing `USER_METER` skips the write so local/tests without
 * the binding cannot overcount unique days.
 */
export async function recordUniqueDynamicWorkerDay(input: {
	env: DynamicWorkerDayEnv
	userId: string | null | undefined
	workerId: string
	now?: Date
}): Promise<void> {
	try {
		if (!input.userId) return
		if (!userMeterNamespace(input.env)) return
		const now = input.now ?? new Date()
		const claimed = await userMeterRpc({
			env: input.env,
			userId: input.userId,
		}).claimDynamicWorkerDay({
			workerId: input.workerId,
			day: utcDayKey(now),
			createdAt: now.toISOString(),
		})
		if (!claimed.created) return
		await recordUsage(input.env, {
			userId: input.userId,
			eventType: 'dynamic_worker_day',
			entityId: input.workerId,
			outcome: 'success',
			timestamp: now.toISOString(),
		})
	} catch (error) {
		console.warn('dynamic-worker-day-record-failed', error)
	}
}
