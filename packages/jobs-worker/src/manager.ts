import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type JobManagerDebugState } from '@kody-internal/shared/jobs/manager-debug.ts'
import {
	type JobExecutionResult,
	type JobRepoCheckPolicy,
	type JobView,
} from '@kody-internal/shared/jobs/types.ts'
import { type JobsWorkerEnv } from './env.ts'

type JobManagerRpc = {
	purgeUser: (payload: { userId: string }) => Promise<{
		ok: true
		userId: string
	}>
	exportUser: (payload: { userId: string }) => Promise<JobManagerDebugState>
	syncAlarm: (payload: {
		userId: string
		source?: 'alarm' | 'rpc' | 'run_now'
	}) => Promise<{
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
	}) => Promise<{
		job: JobView
		execution: JobExecutionResult
		deletedAfterRun: boolean
	}>
}

/**
 * Frozen id contract: one JobManager per user, named by the raw userId.
 * Mirrors `jobManagerDurableObjectName` in the main worker — changing it
 * strands the transferred Durable Object storage.
 */
export function jobManagerStub(
	env: JobsWorkerEnv,
	userId: string,
): JobManagerRpc {
	return env.JOB_MANAGER.get(
		env.JOB_MANAGER.idFromName(userId),
	) as unknown as JobManagerRpc
}
