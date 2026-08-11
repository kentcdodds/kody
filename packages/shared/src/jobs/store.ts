import {
	deleteArchivedJobArtifact,
	listAllArchivedJobArtifactStorageOwnerRows,
	listArchivedJobArtifactsDueBefore,
	listArchivedJobArtifactsForUser,
	upsertArchivedJobArtifact,
	type ArchivedJobArtifactRecord,
} from './archived-artifacts-repo.ts'
import {
	claimJobRow,
	countJobRowsForUser,
	deleteJobRow,
	disableExpiredJobRowsForUser,
	finalizeClaimedJobRow,
	getJobRowById,
	getJobRowInsights,
	getNextRunnableJobRow,
	insertJobRow,
	listAllJobStorageOwnerRows,
	listDueJobRows,
	listJobRetentionCandidateRows,
	listJobRowsByUserId,
	listJobRowsPage,
	listJobStorageIdRowsForUser,
	refreshPackageJobRowIdentity,
	retryClaimedJobRow,
	sumJobRowsStorageBytesForUser,
	updateJobRow,
	type JobRow,
} from './repo.ts'
import { type JobRecord } from './types.ts'

/**
 * Coarse-grained jobs-data contract between the main worker and the jobs
 * worker (ADR 0016). The jobs worker owns the `jobs` and
 * `archived_job_artifacts` tables in its dedicated D1 database and exposes
 * these operations over a typed service binding (`JobsService`). The main
 * worker never queries the jobs tables directly in production; in local dev
 * and tests without the binding it falls back to {@link createD1JobsStore}
 * over its own database (see `jobsStore` in the main worker).
 *
 * Every operation is user-scoped (or an explicitly bounded cross-user
 * maintenance page) — implementations must preserve the per-user isolation
 * invariants of the underlying repo queries.
 */
export type JobsStore = {
	insertJob(input: {
		userId: string
		job: JobRecord
		callerContextJson: string
	}): Promise<void>
	updateJob(input: {
		userId: string
		job: JobRecord
		callerContextJson: string
	}): Promise<boolean>
	getJobById(input: { userId: string; jobId: string }): Promise<JobRow | null>
	listJobsForUser(input: { userId: string }): Promise<Array<JobRow>>
	listJobsPage(input: {
		afterId: string | null
		limit: number
	}): Promise<Array<JobRow>>
	listDueJobs(input: { userId: string; nowIso: string }): Promise<Array<JobRow>>
	getNextRunnableJob(input: {
		userId: string
		nowIso: string
	}): Promise<JobRow | null>
	claimJob(input: {
		userId: string
		jobId: string
		nowMs: number
		claimToken: string
	}): Promise<JobRow | null>
	finalizeClaimedJob(input: {
		userId: string
		job: JobRecord
		claimToken: string
		scheduledFor: string
	}): Promise<boolean>
	retryClaimedJob(input: {
		userId: string
		jobId: string
		claimToken: string
		nextRunAt: string
	}): Promise<boolean>
	refreshPackageJobIdentity(input: {
		userId: string
		jobId: string
		sourceId: string
		publishedCommit: string | null
		callerContextJson: string
		updatedAt: string
	}): Promise<boolean>
	deleteJob(input: { userId: string; jobId: string }): Promise<boolean>
	disableExpiredJobsForUser(input: {
		userId: string
		nowIso: string
	}): Promise<number>
	listJobRetentionCandidates(input: {
		afterId: string | null
		limit: number
	}): Promise<Array<JobRow>>
	upsertArchivedJobArtifact(input: {
		jobId: string
		userId: string
		sourceId: string
		publishedCommit: string
		storageId: string
		retainUntil: string
	}): Promise<string>
	listArchivedJobArtifactsDueBefore(input: {
		retainUntil: string
		limit?: number
	}): Promise<Array<ArchivedJobArtifactRecord>>
	deleteArchivedJobArtifact(input: { id: string }): Promise<void>
	countJobsForUser(input: { userId: string }): Promise<number>
	/**
	 * Text-byte estimate of the user's job rows for the D1 storage quota
	 * (mirrors the main worker's per-table storage byte formula).
	 */
	sumJobsStorageBytesForUser(input: { userId: string }): Promise<number>
	/** Storage ids referenced by the user's jobs and archived artifacts. */
	listJobStorageIdsForUser(input: { userId: string }): Promise<Array<string>>
	listArchivedJobArtifactsForUser(input: {
		userId: string
	}): Promise<Array<ArchivedJobArtifactRecord>>
	/**
	 * Platform-wide (userId, storageId) pairs across jobs and archived
	 * artifacts. Operator-level DR inventory only — never expose on
	 * user-facing paths.
	 */
	listAllJobStorageOwners(): Promise<
		Array<{ userId: string; storageId: string }>
	>
	/** Platform-wide job totals for admin insights. */
	getJobInsights(): Promise<{ total: number; enabled: number }>
	/** Deletes every job and archived-artifact row for the user. */
	purgeUserJobsData(input: { userId: string }): Promise<void>
}

/** D1-backed {@link JobsStore} used by the jobs worker (and dev/test fallback). */
export function createD1JobsStore(db: D1Database): JobsStore {
	return {
		insertJob: async (input) => {
			await insertJobRow({ db, ...input })
		},
		updateJob: (input) => updateJobRow({ db, ...input }),
		getJobById: (input) => getJobRowById(db, input.userId, input.jobId),
		listJobsForUser: (input) => listJobRowsByUserId(db, input.userId),
		listJobsPage: (input) => listJobRowsPage(db, input),
		listDueJobs: (input) => listDueJobRows(db, input.userId, input.nowIso),
		getNextRunnableJob: (input) =>
			getNextRunnableJobRow(db, input.userId, input.nowIso),
		claimJob: (input) =>
			claimJobRow({
				db,
				userId: input.userId,
				jobId: input.jobId,
				now: new Date(input.nowMs),
				claimToken: input.claimToken,
			}),
		finalizeClaimedJob: (input) => finalizeClaimedJobRow({ db, ...input }),
		retryClaimedJob: (input) => retryClaimedJobRow({ db, ...input }),
		refreshPackageJobIdentity: (input) =>
			refreshPackageJobRowIdentity({ db, ...input }),
		deleteJob: (input) => deleteJobRow(db, input.userId, input.jobId),
		disableExpiredJobsForUser: (input) =>
			disableExpiredJobRowsForUser({ db, ...input }),
		listJobRetentionCandidates: (input) =>
			listJobRetentionCandidateRows(db, input),
		upsertArchivedJobArtifact: (input) =>
			upsertArchivedJobArtifact({ db, ...input }),
		listArchivedJobArtifactsDueBefore: (input) =>
			listArchivedJobArtifactsDueBefore(db, input.retainUntil, input.limit),
		deleteArchivedJobArtifact: async (input) => {
			await deleteArchivedJobArtifact(db, input.id)
		},
		countJobsForUser: (input) => countJobRowsForUser(db, input.userId),
		sumJobsStorageBytesForUser: (input) =>
			sumJobRowsStorageBytesForUser(db, input.userId),
		listJobStorageIdsForUser: async (input) => {
			const [jobIds, archived] = await Promise.all([
				listJobStorageIdRowsForUser(db, input.userId),
				listArchivedJobArtifactsForUser(db, input.userId),
			])
			return Array.from(
				new Set([
					...jobIds,
					...archived
						.map((artifact) => artifact.storageId)
						.filter((storageId) => storageId.length > 0),
				]),
			)
		},
		listArchivedJobArtifactsForUser: (input) =>
			listArchivedJobArtifactsForUser(db, input.userId),
		listAllJobStorageOwners: async () => {
			const [jobRows, archivedRows] = await Promise.all([
				listAllJobStorageOwnerRows(db),
				listAllArchivedJobArtifactStorageOwnerRows(db),
			])
			return [...jobRows, ...archivedRows]
		},
		getJobInsights: () => getJobRowInsights(db),
		purgeUserJobsData: async (input) => {
			await db
				.prepare(`DELETE FROM archived_job_artifacts WHERE user_id = ?`)
				.bind(input.userId)
				.run()
			await db
				.prepare(`DELETE FROM jobs WHERE user_id = ?`)
				.bind(input.userId)
				.run()
		},
	}
}
