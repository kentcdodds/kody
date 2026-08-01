import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import {
	AccountDeletionInProgressError,
	withAccountWriteLease,
} from '#worker/account/deletion-state.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { stripePlanRefreshBackstopDelayMs } from './stripe-plan-refresh-client.ts'
import { refreshStripePlanForUser } from './subscription-sync.ts'

const userIdStorageKey = 'user-id'

class StripePlanRefreshBase extends DurableObject<Env> {
	async schedule(input: { userId: string; refreshAt?: number }) {
		const userId = input.userId.trim()
		if (!userId) {
			throw new Error('Stripe plan refresh requires a non-empty userId.')
		}
		const refreshAt =
			input.refreshAt ?? Date.now() + stripePlanRefreshBackstopDelayMs
		if (!Number.isFinite(refreshAt)) {
			throw new Error('Stripe plan refresh requires a finite refreshAt.')
		}
		await this.ctx.storage.put(userIdStorageKey, userId)
		await this.ctx.storage.setAlarm(refreshAt)
		return { scheduledAt: new Date(refreshAt).toISOString() }
	}

	async purgeUser(input: { userId: string }) {
		const storedUserId = await this.ctx.storage.get<string>(userIdStorageKey)
		if (storedUserId && storedUserId !== input.userId.trim()) {
			throw new Error('Stripe plan refresh userId does not match stored owner.')
		}
		await this.ctx.storage.deleteAlarm()
		await this.ctx.storage.deleteAll()
		return { ok: true as const }
	}

	async alarm() {
		const userId = await this.ctx.storage.get<string>(userIdStorageKey)
		if (!userId) {
			await this.ctx.storage.deleteAll()
			return
		}
		const user = await this.env.APP_DB.prepare(
			`SELECT id, stripe_customer_id
			 FROM users
			 WHERE stable_user_id = ?`,
		)
			.bind(userId)
			.first<{ id: number; stripe_customer_id: string | null }>()
		if (!user?.stripe_customer_id) {
			await this.ctx.storage.deleteAll()
			return
		}
		const customerId = user.stripe_customer_id

		try {
			await withAccountWriteLease({
				db: this.env.APP_DB,
				stableUserId: userId,
				holder: 'stripe_plan_refresh_alarm',
				write: async () => {
					await refreshStripePlanForUser({
						env: this.env,
						userId: user.id,
						customerId,
					})
				},
			})
		} catch (error) {
			if (error instanceof AccountDeletionInProgressError) {
				await this.ctx.storage.deleteAll()
				return
			}
			console.error('stripe_plan_refresh_alarm_failed', { userId, error })
			Sentry.withScope((scope) => {
				scope.setTag('billing.operation', 'stripe_plan_refresh_alarm')
				scope.setContext('stripe_plan_refresh', { userId })
				Sentry.captureException(error)
			})
			await this.ctx.storage.setAlarm(
				Date.now() + stripePlanRefreshBackstopDelayMs,
			)
			return
		}
		console.info('stripe_plan_refresh_alarm', {
			userId,
			status: 'refreshed',
		})
		await this.ctx.storage.deleteAll()
	}
}

export const StripePlanRefresh = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	StripePlanRefreshBase,
)
