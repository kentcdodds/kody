import * as Sentry from '@sentry/cloudflare'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { DurableObject } from 'cloudflare:workers'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { getNextRunnableJob, runDueJobsForUser, runJobNow } from './service.ts'
import {
	logJobSchedulerError,
	logJobSchedulerEvent,
	schedulerErrorFields,
	summarizeSchedulerJobOutcomes,
} from './scheduler-logging.ts'
import { type JobRepoCheckPolicy } from './types.ts'

const userIdStorageKey = 'user-id'

export class JobManagerBase extends DurableObject<Env> {
	async syncAlarm(input: { userId: string }) {
		const userId = input.userId.trim()
		if (!userId) {
			throw new Error('Job manager requires a non-empty userId.')
		}
		try {
			await this.ctx.storage.put(userIdStorageKey, userId)
			const currentAlarmAt = await this.ctx.storage.getAlarm()
			const nextJob = await getNextRunnableJob({
				env: this.env,
				userId,
			})
			if (!nextJob) {
				await this.ctx.storage.deleteAlarm()
				logJobSchedulerEvent({
					event: 'sync_alarm',
					userId,
					currentAlarmAt:
						currentAlarmAt == null
							? null
							: new Date(currentAlarmAt).toISOString(),
					nextJobId: null,
					nextRunAt: null,
					reason: 'no-runnable-job',
				})
				return {
					ok: true as const,
					userId,
					nextRunAt: null,
				}
			}
			await this.ctx.storage.setAlarm(new Date(nextJob.nextRunAt))
			logJobSchedulerEvent({
				event: 'sync_alarm',
				userId,
				currentAlarmAt:
					currentAlarmAt == null
						? null
						: new Date(currentAlarmAt).toISOString(),
				nextJobId: nextJob.id,
				nextRunAt: nextJob.nextRunAt,
				reason:
					currentAlarmAt === new Date(nextJob.nextRunAt).valueOf()
						? 'alarm-unchanged'
						: 'alarm-armed',
			})
			return {
				ok: true as const,
				userId,
				nextRunAt: nextJob.nextRunAt,
			}
		} catch (error) {
			logJobSchedulerError({
				event: 'sync_alarm_failed',
				userId,
				...schedulerErrorFields(error),
			})
			throw error
		}
	}

	async alarm(alarmInfo?: {
		retryCount?: number
		isRetry?: boolean
	}): Promise<void> {
		const userId = await this.ctx.storage.get<string>(userIdStorageKey)
		if (!userId) {
			await this.ctx.storage.deleteAlarm()
			logJobSchedulerEvent({
				event: 'alarm_fired',
				reason: 'missing-user-id',
				retryCount: alarmInfo?.retryCount,
				isRetry: alarmInfo?.isRetry,
			})
			return
		}
		logJobSchedulerEvent({
			event: 'alarm_fired',
			userId,
			retryCount: alarmInfo?.retryCount,
			isRetry: alarmInfo?.isRetry,
		})
		try {
			const result = await runDueJobsForUser({
				env: this.env,
				userId,
			})
			logJobSchedulerEvent({
				event: 'alarm_processed_due_jobs',
				userId,
				dueJobCount: result.dueJobCount,
				successCount: result.successCount,
				errorCount: result.errorCount,
				reason: result.dueJobCount === 0 ? 'no-due-jobs' : 'processed-due-jobs',
				...summarizeSchedulerJobOutcomes(result.jobOutcomes),
			})
		} catch (error) {
			logJobSchedulerError({
				event: 'alarm_run_due_jobs_failed',
				userId,
				retryCount: alarmInfo?.retryCount,
				isRetry: alarmInfo?.isRetry,
				...schedulerErrorFields(error),
			})
			throw error
		}
		try {
			await this.syncAlarm({ userId })
		} catch (error) {
			logJobSchedulerError({
				event: 'alarm_resync_failed',
				userId,
				retryCount: alarmInfo?.retryCount,
				isRetry: alarmInfo?.isRetry,
				...schedulerErrorFields(error),
			})
			throw error
		}
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
