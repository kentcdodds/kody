import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	buildJobInspectionOutput,
	buildJobManagerDebugOutput,
} from '#mcp/capabilities/jobs/shared.ts'
import { type JobManagerDebugState } from '#worker/jobs/manager-client.ts'
import { inspectJobsForUser } from '#worker/jobs/service.ts'
import { type JobSchedule, type JobView } from '#worker/jobs/types.ts'
import { listRunRecords } from '#worker/run-records/service.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export type JobOwnership = 'ad-hoc' | 'package'

export type AccountJobListItem = {
	id: string
	name: string
	ownership: JobOwnership
	scheduleSummary: string
	timezone: string
	enabled: boolean
	killSwitchEnabled: boolean
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

export type AccountJobsLoaderData = {
	ok: true
	jobs: Array<AccountJobListItem>
	selectedJob: AccountJobDetail | null
	selectedJobId: string | null
	alarm?: AccountJobsAlarm
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
	inspection = buildJobInspectionOutput(job),
): AccountJobListItem {
	return {
		id: job.id,
		name: job.name,
		ownership: jobOwnershipForId(job.id),
		scheduleSummary: job.scheduleSummary,
		timezone: job.timezone,
		enabled: job.enabled,
		killSwitchEnabled: job.killSwitchEnabled,
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
}): Promise<AccountJobDetail> {
	const inspection = buildJobInspectionOutput(input.job)
	const recentRuns = await loadRecentRunsForJob({
		env: input.env,
		userId: input.userId,
		jobId: input.job.id,
	})
	return {
		...toListItem(input.job, inspection),
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
	const inspection = await inspectJobsForUser({
		env: input.env,
		userId,
	})
	const selectedRecord = selectedJobId
		? (inspection.jobs.find((job) => job.id === selectedJobId) ?? null)
		: null

	return {
		ok: true,
		jobs: inspection.jobs.map((job) => toListItem(job)),
		selectedJob: selectedRecord
			? await toDetail({
					env: input.env,
					userId,
					job: selectedRecord,
				})
			: null,
		selectedJobId,
		alarm: toAlarm(inspection.alarm),
	}
}
