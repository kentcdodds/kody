import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { getNextRunnableJob } from './service.ts'
import { runDueJobsForUser } from './service.ts'

const userIdStorageKey = 'user-id'

class JobManagerBase extends DurableObject<Env> {
	async syncAlarm(input: { userId: string }) {
		const userId = input.userId.trim()
		if (!userId) {
			throw new Error('Job manager requires a non-empty userId.')
		}
		await this.ctx.storage.put(userIdStorageKey, userId)
		const nextJob = await getNextRunnableJob({
			env: this.env,
			userId,
		})
		if (!nextJob) {
			await this.ctx.storage.deleteAlarm()
			return {
				ok: true as const,
				userId,
				nextRunAt: null,
			}
		}
		await this.ctx.storage.setAlarm(new Date(nextJob.nextRunAt))
		return {
			ok: true as const,
			userId,
			nextRunAt: nextJob.nextRunAt,
		}
	}

	async alarm(): Promise<void> {
		const userId = await this.ctx.storage.get<string>(userIdStorageKey)
		if (!userId) {
			await this.ctx.storage.deleteAlarm()
			return
		}
		await runDueJobsForUser({
			env: this.env,
			userId,
		})
		await this.syncAlarm({ userId })
	}
}

export const JobManager = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	JobManagerBase,
)

export function jobManagerRpc(env: Env, userId: string) {
	return env.JOB_MANAGER.get(env.JOB_MANAGER.idFromName(userId)) as unknown as {
		syncAlarm: (payload: { userId: string }) => Promise<{
			ok: true
			userId: string
			nextRunAt: string | null
		}>
	}
}

export async function syncJobManagerAlarm(input: { env: Env; userId: string }) {
	return jobManagerRpc(input.env, input.userId).syncAlarm({
		userId: input.userId,
	})
}
