import {
	AccountDeletionInProgressError,
	withAccountWriteLease,
} from '#worker/account/deletion-state.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { stripePlanRefreshDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'

export const stripePlanRefreshBackstopDelayMs = 60 * 60 * 1000

export async function scheduleStripePlanRefreshBackstop(input: {
	env: Env
	/** Personal org id (= owner stable user id) or team org id. */
	userId: string
	now?: Date
}) {
	const userId = input.userId.trim()
	if (!userId) return false
	try {
		const activityAt = input.now?.getTime() ?? Date.now()
		const refreshAt =
			Math.max(activityAt, Date.now()) + stripePlanRefreshBackstopDelayMs
		const id = input.env.STRIPE_PLAN_REFRESH.idFromName(
			stripePlanRefreshDurableObjectName(userId),
		)
		const stub = input.env.STRIPE_PLAN_REFRESH.get(id)
		const schedule = async () => {
			await stub.schedule({
				userId,
				refreshAt,
			})
		}
		const personalUser = await input.env.APP_DB.prepare(
			`SELECT 1 AS ok FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
			.bind(userId)
			.first<{ ok: number }>()
		if (personalUser) {
			await withAccountWriteLease({
				db: input.env.APP_DB,
				stableUserId: userId,
				holder: 'stripe_plan_refresh_schedule',
				env: input.env,
				write: schedule,
			})
		} else {
			// Team org: no users row / account deletion lease. Schedule directly.
			await schedule()
		}
		return true
	} catch (error) {
		if (error instanceof AccountDeletionInProgressError) return false
		console.error('stripe_plan_refresh_schedule_failed', { userId, error })
		return false
	}
}

export async function purgeStripePlanRefreshForUser(input: {
	env: Env
	userId: string
}) {
	const namespace = (input.env as Partial<Env>).STRIPE_PLAN_REFRESH
	if (!namespace) return { purged: false }
	const userId = input.userId.trim()
	const id = namespace.idFromName(stripePlanRefreshDurableObjectName(userId))
	await namespace.get(id).purgeUser({ userId })
	return { purged: true }
}
