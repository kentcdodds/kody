import * as Sentry from '@sentry/cloudflare'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { DurableObject } from 'cloudflare:workers'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { getNextRunnableJob, runDueJobsForUser, runJobNow } from './service.ts'
import {
	type JobRepoCheckPolicy,
} from './types.ts'
import {
	type JobManagerDebugState,
	type JobManagerDebugStatus,
} from './manager-client.ts'

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

	async getDebugState(input: { userId: string }): Promise<JobManagerDebugState> {
		const userId = input.userId.trim()
		if (!userId) {
			throw new Error('Job manager requires a non-empty userId.')
		}
		const [storedUserId, alarmTimestamp, nextJob] = await Promise.all([
			this.ctx.storage.get<string>(userIdStorageKey),
			this.ctx.storage.getAlarm(),
			getNextRunnableJob({
				env: this.env,
				userId,
			}),
		])
		const alarmScheduledFor =
			typeof alarmTimestamp === 'number'
				? new Date(alarmTimestamp).toISOString()
				: null
		const nextRunnableRunAt = nextJob?.nextRunAt ?? null
		const alarmInSync =
			nextRunnableRunAt == null
				? alarmScheduledFor === null
				: alarmScheduledFor === nextRunnableRunAt
		const status: JobManagerDebugStatus =
			nextRunnableRunAt == null
				? alarmScheduledFor == null
					? 'idle'
					: 'out_of_sync'
				: alarmScheduledFor === nextRunnableRunAt
					? 'armed'
					: 'out_of_sync'
		return {
			bindingAvailable: true,
			status,
			storedUserId: storedUserId ?? null,
			alarmScheduledFor,
			nextRunnableJobId: nextJob?.id ?? null,
			nextRunnableRunAt,
			alarmInSync,
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

	async runNow(input: {
		userId: string
		jobId: string
		callerContext?: McpCallerContext | null
		repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	}) {
		let result: Awaited<ReturnType<typeof runJobNow>> | undefined
		let originalError: unknown
		try {
			result = await runJobNow({
				env: this.env,
				userId: input.userId,
				jobId: input.jobId,
				callerContext: input.callerContext ?? null,
				repoCheckPolicyOverride: input.repoCheckPolicyOverride,
			})
		} catch (error) {
			originalError = error
		}
		try {
			await this.syncAlarm({ userId: input.userId })
		} catch (syncError) {
			console.error('[JobManager.runNow] failed to sync job alarm', {
				userId: input.userId,
				jobId: input.jobId,
				syncError,
			})
		}
		if (originalError) {
			throw originalError
		}
		return result!
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
		getDebugState: (payload: {
			userId: string
		}) => Promise<JobManagerDebugState>
		runNow: (payload: {
			userId: string
			jobId: string
			callerContext?: McpCallerContext | null
			repoCheckPolicyOverride?: JobRepoCheckPolicy | null
		}) => Promise<Awaited<ReturnType<typeof runJobNow>>>
	}
}

export async function syncJobManagerAlarm(input: { env: Env; userId: string }) {
	return jobManagerRpc(input.env, input.userId).syncAlarm({
		userId: input.userId,
	})
}

export async function runJobNowViaManager(input: {
	env: Env
	userId: string
	jobId: string
	callerContext?: McpCallerContext | null
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
}) {
	return jobManagerRpc(input.env, input.userId).runNow({
		userId: input.userId,
		jobId: input.jobId,
		callerContext: input.callerContext ?? null,
		repoCheckPolicyOverride: input.repoCheckPolicyOverride,
	})
}
