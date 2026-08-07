import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	buildJobInspectionOutput,
	buildJobManagerDebugOutput,
} from '#mcp/capabilities/jobs/shared.ts'
import { type JobManagerDebugState } from '#worker/jobs/manager-client.ts'
import {
	defaultJobRetentionDays,
	type JobRetentionPreferences,
} from '#worker/jobs/job-retention.ts'
import { readJobRetentionPreferencesForUser } from '#worker/jobs/job-retention-cleanup.ts'
import { inspectJobsForUser } from '#worker/jobs/inspect.ts'
import { type JobSchedule, type JobView } from '#worker/jobs/types.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { listRunRecords } from '#worker/run-records/service.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export type JobOwnership = 'ad-hoc' | 'package'

export type AccountJobListItem = {
	id: string
	name: string
	ownership: JobOwnership
	packageId: string | null
	packageName: string | null
	scheduleSummary: string
	scheduleType: JobSchedule['type']
	timezone: string
	enabled: boolean
	killSwitchEnabled: boolean
	preserved: boolean
	expiresAt: string | null
	expired: boolean
	dueNow: boolean
	lastRunStatus: 'success' | 'error' | null
	nextRunAt: string
	lastRunAt: string | null
	runCount: number
	successCount: number
	errorCount: number
}

export type AccountJobRecentRun = {
	id: string
	startedAt: string
	finishedAt: string
	status: 'success' | 'error' | 'running'
	durationMs: number
	error: string | null
}

export type AccountJobSchedule = JobSchedule

export type AccountJobDetail = AccountJobListItem & {
	params: Record<string, unknown> | null
	schedule: AccountJobSchedule
	lastRunError: string | null
	lastDurationMs: number | null
	recentRuns: Array<AccountJobRecentRun>
	storageId: string
	sourceId: string
	publishedCommit: string | null
	createdAt: string
	updatedAt: string
}

export type AccountJobsAlarm = {
	bindingAvailable: boolean
	status: JobManagerDebugState['status']
	storedUserId: string | null
	alarmScheduledFor: string | null
	nextRunnableJobId: string | null
	nextRunnableRunAt: string | null
	alarmInSync: boolean | null
}

export type AccountJobRetentionPreferences = JobRetentionPreferences & {
	defaults: typeof defaultJobRetentionDays
}

export type AccountJobsLoaderData = {
	ok: true
	jobs: Array<AccountJobListItem>
	selectedJob: AccountJobDetail | null
	selectedJobId: string | null
	alarm?: AccountJobsAlarm
	retention: AccountJobRetentionPreferences
}

const accountJobsBasePath = '/account/jobs'
const packageJobIdPrefix = 'package-job:'
const recentRunsLimit = 20

export function isPackageOwnedJobId(jobId: string) {
	return jobId.startsWith(packageJobIdPrefix)
}

export function jobOwnershipForId(jobId: string): JobOwnership {
	return isPackageOwnedJobId(jobId) ? 'package' : 'ad-hoc'
}

/**
 * Package job ids are `package-job:{packageId}:{encodeURIComponent(jobName)}`.
 * Returns null for ad-hoc jobs or malformed package job ids.
 */
export function packageIdFromJobId(jobId: string): string | null {
	if (!isPackageOwnedJobId(jobId)) return null
	const rest = jobId.slice(packageJobIdPrefix.length)
	const separatorIndex = rest.indexOf(':')
	if (separatorIndex <= 0) return null
	const packageId = rest.slice(0, separatorIndex).trim()
	return packageId || null
}

export function readAccountJobsSelectedJobId(
	requestUrl: string,
	pathJobId?: string,
) {
	if (pathJobId?.trim()) return pathJobId.trim()
	const url = new URL(requestUrl, 'http://localhost')
	const detailPrefix = `${accountJobsBasePath}/`
	if (url.pathname.startsWith(detailPrefix)) {
		const segment = url.pathname.slice(detailPrefix.length)
		if (segment && !segment.includes('/')) {
			try {
				const jobId = decodeURIComponent(segment)
				if (jobId) return jobId
			} catch {
				if (segment) return segment
			}
		}
	}
	const selected = url.searchParams.get('selected')?.trim()
	return selected ? selected : null
}

function toListItem(
	job: JobView,
	packageNamesById: ReadonlyMap<string, string>,
	inspection = buildJobInspectionOutput(job),
): AccountJobListItem {
	const packageId = packageIdFromJobId(job.id)
	return {
		id: job.id,
		name: job.name,
		ownership: jobOwnershipForId(job.id),
		packageId,
		packageName: packageId ? (packageNamesById.get(packageId) ?? null) : null,
		scheduleSummary: job.scheduleSummary,
		scheduleType: job.schedule.type,
		timezone: job.timezone,
		enabled: job.enabled,
		killSwitchEnabled: job.killSwitchEnabled,
		preserved: job.preserved,
		expiresAt: inspection.expires_at,
		expired: inspection.expired,
		dueNow: inspection.due_now,
		lastRunStatus: job.lastRunStatus ?? null,
		nextRunAt: job.nextRunAt,
		lastRunAt: job.lastRunAt ?? null,
		runCount: job.runCount,
		successCount: job.successCount,
		errorCount: job.errorCount,
	}
}

async function loadRecentRunsForJob(input: {
	env: Env
	userId: string
	jobId: string
}): Promise<Array<AccountJobRecentRun>> {
	const page = await listRunRecords({
		env: input.env,
		userId: input.userId,
		filter: { jobId: input.jobId },
		limit: recentRunsLimit,
	})
	return page.runs.map((run) => ({
		id: run.id,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt ?? run.startedAt,
		status: run.status,
		durationMs: run.durationMs ?? 0,
		error: run.errorMessage,
	}))
}

async function toDetail(input: {
	env: Env
	userId: string
	job: JobView
	packageNamesById: ReadonlyMap<string, string>
}): Promise<AccountJobDetail> {
	const inspection = buildJobInspectionOutput(input.job)
	const recentRuns = await loadRecentRunsForJob({
		env: input.env,
		userId: input.userId,
		jobId: input.job.id,
	})
	return {
		...toListItem(input.job, input.packageNamesById, inspection),
		params: input.job.params ?? null,
		schedule: input.job.schedule,
		lastRunError: input.job.lastRunError ?? null,
		lastDurationMs: input.job.lastDurationMs ?? null,
		recentRuns,
		storageId: input.job.storageId,
		sourceId: input.job.sourceId,
		publishedCommit: input.job.publishedCommit,
		createdAt: input.job.createdAt,
		updatedAt: input.job.updatedAt,
	}
}

function toAlarm(state: JobManagerDebugState): AccountJobsAlarm {
	const debug = buildJobManagerDebugOutput(state)
	return {
		bindingAvailable: debug.binding_available,
		status: debug.status,
		storedUserId: debug.stored_user_id,
		alarmScheduledFor: debug.alarm_scheduled_for,
		nextRunnableJobId: debug.next_runnable_job_id,
		nextRunnableRunAt: debug.next_runnable_run_at,
		alarmInSync: debug.alarm_in_sync,
	}
}

export async function loadAccountJobsData(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	pathJobId?: string
}): Promise<AccountJobsLoaderData> {
	const userId = input.user.mcpUser.userId
	const selectedJobId = readAccountJobsSelectedJobId(
		input.request.url,
		input.pathJobId,
	)
	const [inspection, savedPackages, retentionPreferences] = await Promise.all([
		inspectJobsForUser({
			env: input.env,
			userId,
		}),
		listSavedPackagesByUserId(input.env.APP_DB, { userId }),
		readJobRetentionPreferencesForUser({
			db: input.env.APP_DB,
			userId,
		}),
	])
	const packageNamesById = new Map(
		savedPackages.map((savedPackage) => [savedPackage.id, savedPackage.name]),
	)
	const selectedRecord = selectedJobId
		? (inspection.jobs.find((job) => job.id === selectedJobId) ?? null)
		: null

	return {
		ok: true,
		jobs: inspection.jobs.map((job) => toListItem(job, packageNamesById)),
		selectedJob: selectedRecord
			? await toDetail({
					env: input.env,
					userId,
					job: selectedRecord,
					packageNamesById,
				})
			: null,
		selectedJobId,
		alarm: toAlarm(inspection.alarm),
		retention: {
			...retentionPreferences,
			defaults: defaultJobRetentionDays,
		},
	}
}
