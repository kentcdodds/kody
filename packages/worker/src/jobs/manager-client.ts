import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	logJobSchedulerError,
	logJobSchedulerEvent,
	schedulerErrorFields,
} from './scheduler-logging.ts'
import {
	type JobExecutionResult,
	type JobRepoCheckPolicy,
	type JobView,
} from './types.ts'

type JobManagerRpc = {
	syncAlarm: (payload: {
		userId: string
		source?: 'alarm' | 'rpc' | 'run_now'
	}) => Promise<{
		ok: true
		userId: string
		nextRunAt: string | null
	}>
	runNow: (payload: {
		userId: string
		jobId: string
		callerContext?: McpCallerContext | null
		repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	}) => Promise<{
		job: JobView
		execution: JobExecutionResult
	}>
}

export function jobManagerRpc(env: Env, userId: string): JobManagerRpc | null {
	const namespace = env.JOB_MANAGER
	if (!namespace) {
		return null
	}
	return namespace.get(namespace.idFromName(userId)) as unknown as JobManagerRpc
}

export async function syncJobManagerAlarm(input: { env: Env; userId: string }) {
	const rpc = jobManagerRpc(input.env, input.userId)
	if (!rpc) {
		logJobSchedulerEvent({
			event: 'sync_alarm_skipped_missing_binding',
			userId: input.userId,
			reason: 'missing_job_manager_binding',
		})
		return {
			ok: true as const,
			userId: input.userId,
			nextRunAt: null,
		}
	}
	logJobSchedulerEvent({
		event: 'sync_alarm_requested',
		userId: input.userId,
	})
	try {
		const result = await rpc.syncAlarm({
			userId: input.userId,
			source: 'rpc',
		})
		logJobSchedulerEvent({
			event: 'sync_alarm_completed',
			userId: result.userId,
			nextRunAt: result.nextRunAt,
			reason:
				result.nextRunAt == null
					? 'no_runnable_job_found'
					: 'alarm_state_updated',
		})
		return result
	} catch (error) {
		logJobSchedulerError({
			event: 'sync_alarm_request_failed',
			userId: input.userId,
			...schedulerErrorFields(error),
		})
		throw error
	}
}

export async function runJobNowViaManager(input: {
	env: Env
	userId: string
	jobId: string
	callerContext?: McpCallerContext | null
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
}) {
	const rpc = jobManagerRpc(input.env, input.userId)
	if (!rpc) {
		throw new Error('Missing JOB_MANAGER binding for jobs scheduling.')
	}
	return rpc.runNow({
		userId: input.userId,
		jobId: input.jobId,
		callerContext: input.callerContext ?? null,
		repoCheckPolicyOverride: input.repoCheckPolicyOverride,
	})
}
