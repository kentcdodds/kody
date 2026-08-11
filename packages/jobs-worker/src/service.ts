import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type JobManagerDebugState } from '@kody-internal/shared/jobs/manager-debug.ts'
import {
	type JobsServiceContract,
	type JobsHostContract,
} from '@kody-internal/shared/jobs/rpc.ts'
import { type ArchivedJobArtifactRecord } from '@kody-internal/shared/jobs/archived-artifacts-repo.ts'
import { type JobRow } from '@kody-internal/shared/jobs/repo.ts'
import {
	type JobRecord,
	type JobRepoCheckPolicy,
} from '@kody-internal/shared/jobs/types.ts'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { type JobsWorkerEnv } from './env.ts'
import { jobManagerStub } from './manager.ts'
import { jobsStore } from './store.ts'

/**
 * `JobsService` — the coarse-grained RPC surface the main worker reaches
 * through its JOBS service binding (ADR 0016). Implements
 * {@link JobsServiceContract}: the jobs-data store over the dedicated jobs D1
 * plus the JobManager Durable Object scheduling operations. Every operation
 * is user-scoped; userId always comes from the caller (the main worker
 * resolves it from the authenticated session/caller context).
 */
export class JobsService
	extends WorkerEntrypoint<JobsWorkerEnv>
	implements JobsServiceContract
{
	async insertJob(input: {
		userId: string
		job: JobRecord
		callerContextJson: string
	}): Promise<void> {
		await jobsStore(this.env).insertJob(input)
	}

	async updateJob(input: {
		userId: string
		job: JobRecord
		callerContextJson: string
	}): Promise<boolean> {
		return jobsStore(this.env).updateJob(input)
	}

	async getJobById(input: {
		userId: string
		jobId: string
	}): Promise<JobRow | null> {
		return jobsStore(this.env).getJobById(input)
	}

	async listJobsForUser(input: { userId: string }): Promise<Array<JobRow>> {
		return jobsStore(this.env).listJobsForUser(input)
	}

	async listJobsPage(input: {
		afterId: string | null
		limit: number
	}): Promise<Array<JobRow>> {
		return jobsStore(this.env).listJobsPage(input)
	}

	async listDueJobs(input: {
		userId: string
		nowIso: string
	}): Promise<Array<JobRow>> {
		return jobsStore(this.env).listDueJobs(input)
	}

	async getNextRunnableJob(input: {
		userId: string
		nowIso: string
	}): Promise<JobRow | null> {
		return jobsStore(this.env).getNextRunnableJob(input)
	}

	async claimJob(input: {
		userId: string
		jobId: string
		nowMs: number
		claimToken: string
	}): Promise<JobRow | null> {
		return jobsStore(this.env).claimJob(input)
	}

	async finalizeClaimedJob(input: {
		userId: string
		job: JobRecord
		claimToken: string
		scheduledFor: string
	}): Promise<boolean> {
		return jobsStore(this.env).finalizeClaimedJob(input)
	}

	async retryClaimedJob(input: {
		userId: string
		jobId: string
		claimToken: string
		nextRunAt: string
	}): Promise<boolean> {
		return jobsStore(this.env).retryClaimedJob(input)
	}

	async refreshPackageJobIdentity(input: {
		userId: string
		jobId: string
		sourceId: string
		publishedCommit: string | null
		callerContextJson: string
		updatedAt: string
	}): Promise<boolean> {
		return jobsStore(this.env).refreshPackageJobIdentity(input)
	}

	async deleteJob(input: { userId: string; jobId: string }): Promise<boolean> {
		return jobsStore(this.env).deleteJob(input)
	}

	async disableExpiredJobsForUser(input: {
		userId: string
		nowIso: string
	}): Promise<number> {
		return jobsStore(this.env).disableExpiredJobsForUser(input)
	}

	async listJobRetentionCandidates(input: {
		afterId: string | null
		limit: number
	}): Promise<Array<JobRow>> {
		return jobsStore(this.env).listJobRetentionCandidates(input)
	}

	async upsertArchivedJobArtifact(input: {
		jobId: string
		userId: string
		sourceId: string
		publishedCommit: string
		storageId: string
		retainUntil: string
	}): Promise<string> {
		return jobsStore(this.env).upsertArchivedJobArtifact(input)
	}

	async listArchivedJobArtifactsDueBefore(input: {
		retainUntil: string
		limit?: number
	}): Promise<Array<ArchivedJobArtifactRecord>> {
		return jobsStore(this.env).listArchivedJobArtifactsDueBefore(input)
	}

	async deleteArchivedJobArtifact(input: { id: string }): Promise<void> {
		await jobsStore(this.env).deleteArchivedJobArtifact(input)
	}

	async syncAlarm(input: {
		userId: string
	}): Promise<{ ok: true; userId: string; nextRunAt: string | null }> {
		return jobManagerStub(this.env, input.userId).syncAlarm({
			userId: input.userId,
			source: 'rpc',
		})
	}

	async getDebugState(input: {
		userId: string
	}): Promise<JobManagerDebugState> {
		return jobManagerStub(this.env, input.userId).getDebugState(input)
	}

	async exportUser(input: { userId: string }): Promise<JobManagerDebugState> {
		return jobManagerStub(this.env, input.userId).exportUser(input)
	}

	/**
	 * Account-deletion hook: removes every jobs-database row for the user and
	 * purges the JobManager Durable Object storage (including its alarm).
	 */
	async purgeUser(input: {
		userId: string
	}): Promise<{ ok: true; userId: string; purged: boolean }> {
		const userId = input.userId.trim()
		if (!userId) {
			throw new Error('Jobs purge requires a non-empty userId.')
		}
		await this.env.JOBS_DB.prepare(
			`DELETE FROM archived_job_artifacts WHERE user_id = ?`,
		)
			.bind(userId)
			.run()
		await this.env.JOBS_DB.prepare(`DELETE FROM jobs WHERE user_id = ?`)
			.bind(userId)
			.run()
		await jobManagerStub(this.env, userId).purgeUser({ userId })
		return { ok: true as const, userId, purged: true }
	}

	async runJobNow(input: {
		userId: string
		jobId: string
		callerContext?: McpCallerContext | null
		repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	}): Promise<Awaited<ReturnType<JobsHostContract['runJobNow']>>> {
		return jobManagerStub(this.env, input.userId).runNow({
			userId: input.userId,
			jobId: input.jobId,
			callerContext: input.callerContext ?? null,
			repoCheckPolicyOverride: input.repoCheckPolicyOverride ?? null,
		})
	}
}
