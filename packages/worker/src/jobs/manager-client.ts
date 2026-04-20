import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type JobRepoCheckPolicy } from './types.ts'

export type JobManagerDebugState = {
	bindingAvailable: boolean
	status: 'missing_binding' | 'idle' | 'armed' | 'out_of_sync'
	storedUserId: string | null
	alarmScheduledFor: string | null
	nextRunnableJobId: string | null
	nextRunnableRunAt: string | null
	alarmInSync: boolean | null
}

type JobManagerRpc = {
	syncAlarm: (payload: { userId: string }) => Promise<{
		ok: true
		userId: string
		nextRunAt: string | null
	}>
	getDebugState: (payload: { userId: string }) => Promise<JobManagerDebugState>
	runNow: (payload: {
		userId: string
		jobId: string
		callerContext?: McpCallerContext | null
		repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	}) => Promise<unknown>
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
		return {
			ok: true as const,
			userId: input.userId,
			nextRunAt: null,
		}
	}
	return rpc.syncAlarm({
		userId: input.userId,
	})
}

export async function getJobManagerDebugState(input: {
	env: Env
	userId: string
}) {
	const rpc = jobManagerRpc(input.env, input.userId)
	if (!rpc) {
		return {
			bindingAvailable: false,
			status: 'missing_binding' as const,
			storedUserId: null,
			alarmScheduledFor: null,
			nextRunnableJobId: null,
			nextRunnableRunAt: null,
			alarmInSync: null,
		}
	}
	return rpc.getDebugState({
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
