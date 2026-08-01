import { stripePlanRefreshDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'

export const stripePlanRefreshBackstopDelayMs = 60 * 60 * 1000

export async function scheduleStripePlanRefreshBackstop(input: {
	env: Env
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
		await stub.schedule({
			userId,
			refreshAt,
		})
		return true
	} catch (error) {
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
	const id = namespace.idFromName(
		stripePlanRefreshDurableObjectName(input.userId),
	)
	await namespace.get(id).purgeUser({ userId: input.userId })
	return { purged: true }
}
