import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	getRunRecord,
	listRunRecords,
	summarizeRunRecords,
} from '#worker/run-records/service.ts'
import {
	type RunErrorTriage,
	type RunErrorTriageFilter,
	type RunLogLevel,
	type RunRecord,
	type RunRecordLog,
	type RunStatus,
	type RunSurface,
	runErrorTriageFilterValues,
	runRecordRetentionDays,
	runSurfaceValues,
} from '#worker/run-records/types.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export const accountActivityStatusFilterValues = [
	'error',
	'all',
	'running',
] as const

export type AccountActivityStatusFilter =
	(typeof accountActivityStatusFilterValues)[number]

export const accountActivitySurfaceFilterValues = [
	'all',
	...runSurfaceValues,
] as const

export type AccountActivitySurfaceFilter =
	(typeof accountActivitySurfaceFilterValues)[number]

export const accountActivityTriageFilterValues = runErrorTriageFilterValues

export type AccountActivityTriageFilter = RunErrorTriageFilter

export type AccountActivityRunListItem = {
	id: string
	surface: RunSurface
	status: RunStatus
	name: string | null
	startedAt: string
	finishedAt: string | null
	durationMs: number | null
	errorName: string | null
	errorMessage: string | null
	errorTriage: RunErrorTriage | null
	packageId: string | null
	jobId: string | null
	logCount: number
}

export type AccountActivityRunLog = {
	sequence: number
	level: RunLogLevel
	message: string
	fields: Record<string, unknown> | null
}

export type AccountActivityRunDetail = AccountActivityRunListItem & {
	kodyId: string | null
	sourceId: string | null
	publishedCommit: string | null
	storageId: string | null
	workflowId: string | null
	invocationId: string | null
	sessionId: string | null
	idempotencyKey: string | null
	parentRunId: string | null
	triageNote: string | null
	triagedAt: string | null
	triagedBy: string | null
	metadata: Record<string, unknown>
	logs: Array<AccountActivityRunLog>
}

export type AccountActivitySummary = {
	since: string
	total: number
	errors: number
	ignored: number
	resolved: number
	running: number
}

export type AccountActivityLoaderData = {
	ok: true
	statusFilter: AccountActivityStatusFilter
	surfaceFilter: AccountActivitySurfaceFilter
	triageFilter: AccountActivityTriageFilter
	summary: AccountActivitySummary
	runs: Array<AccountActivityRunListItem>
	nextCursor: string | null
	selectedRun: AccountActivityRunDetail | null
	selectedRunId: string | null
	retentionDays: number
}

const accountActivityBasePath = '/account/activity'
const summaryWindowMs = 7 * 24 * 60 * 60 * 1000
const defaultPageSize = 25

export function isAccountActivityStatusFilter(
	value: string | null | undefined,
): value is AccountActivityStatusFilter {
	return (
		typeof value === 'string' &&
		(accountActivityStatusFilterValues as ReadonlyArray<string>).includes(value)
	)
}

export function isAccountActivitySurfaceFilter(
	value: string | null | undefined,
): value is AccountActivitySurfaceFilter {
	return (
		typeof value === 'string' &&
		(accountActivitySurfaceFilterValues as ReadonlyArray<string>).includes(
			value,
		)
	)
}

export function isAccountActivityTriageFilter(
	value: string | null | undefined,
): value is AccountActivityTriageFilter {
	return (
		typeof value === 'string' &&
		(accountActivityTriageFilterValues as ReadonlyArray<string>).includes(value)
	)
}

export function readAccountActivitySelectedRunId(
	requestUrl: string,
	pathRunId?: string,
) {
	if (pathRunId?.trim()) return pathRunId.trim()
	const url = new URL(requestUrl, 'http://localhost')
	const detailPrefix = `${accountActivityBasePath}/`
	if (url.pathname.startsWith(detailPrefix)) {
		const segment = url.pathname.slice(detailPrefix.length)
		if (segment && !segment.includes('/')) {
			try {
				const runId = decodeURIComponent(segment)
				if (runId) return runId
			} catch {
				if (segment) return segment
			}
		}
	}
	const selected = url.searchParams.get('selected')?.trim()
	return selected ? selected : null
}

export function readAccountActivityFilters(requestUrl: string) {
	const url = new URL(requestUrl, 'http://localhost')
	const statusRaw = url.searchParams.get('status')?.trim() ?? null
	const surfaceRaw = url.searchParams.get('surface')?.trim() ?? null
	const triageRaw =
		url.searchParams.get('error_triage')?.trim() ??
		url.searchParams.get('triage')?.trim() ??
		null
	const cursor = url.searchParams.get('cursor')?.trim() || null
	return {
		statusFilter: isAccountActivityStatusFilter(statusRaw)
			? statusRaw
			: ('error' satisfies AccountActivityStatusFilter),
		surfaceFilter: isAccountActivitySurfaceFilter(surfaceRaw)
			? surfaceRaw
			: ('all' satisfies AccountActivitySurfaceFilter),
		triageFilter: isAccountActivityTriageFilter(triageRaw)
			? triageRaw
			: ('open' satisfies AccountActivityTriageFilter),
		cursor,
	}
}

export function statusFilterToRunStatus(
	filter: AccountActivityStatusFilter,
): RunStatus | null {
	switch (filter) {
		case 'error':
			return 'error'
		case 'running':
			return 'running'
		case 'all':
			return null
		default: {
			const exhaustive: never = filter
			return exhaustive
		}
	}
}

export function surfaceFilterToRunSurface(
	filter: AccountActivitySurfaceFilter,
): RunSurface | null {
	if (filter === 'all') return null
	return filter
}

function toListItem(run: RunRecord): AccountActivityRunListItem {
	return {
		id: run.id,
		surface: run.surface,
		status: run.status,
		name: run.name,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		durationMs: run.durationMs,
		errorName: run.errorName,
		errorMessage: run.errorMessage,
		errorTriage: run.errorTriage,
		packageId: run.packageId,
		jobId: run.jobId,
		logCount: run.logCount,
	}
}

function toDetail(
	run: RunRecord,
	logs: Array<RunRecordLog>,
): AccountActivityRunDetail {
	return {
		...toListItem(run),
		kodyId: run.kodyId,
		sourceId: run.sourceId,
		publishedCommit: run.publishedCommit,
		storageId: run.storageId,
		workflowId: run.workflowId,
		invocationId: run.invocationId,
		sessionId: run.sessionId,
		idempotencyKey: run.idempotencyKey,
		parentRunId: run.parentRunId,
		triageNote: run.triageNote,
		triagedAt: run.triagedAt,
		triagedBy: run.triagedBy,
		metadata: run.metadata,
		logs: logs
			.slice()
			.sort((a, b) => a.sequence - b.sequence)
			.map((entry) => ({
				sequence: entry.sequence,
				level: entry.level,
				message: entry.message,
				fields: entry.fields,
			})),
	}
}

function summarySince(now: Date) {
	return new Date(now.getTime() - summaryWindowMs).toISOString()
}

export async function loadAccountActivityData(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	pathRunId?: string
	now?: Date
}): Promise<AccountActivityLoaderData> {
	const userId = input.user.mcpUser.userId
	const now = input.now ?? new Date()
	const selectedRunId = readAccountActivitySelectedRunId(
		input.request.url,
		input.pathRunId,
	)
	const { statusFilter, surfaceFilter, triageFilter, cursor } =
		readAccountActivityFilters(input.request.url)
	const since = summarySince(now)

	const [summary, page, selectedRecord] = await Promise.all([
		summarizeRunRecords({
			env: input.env,
			userId,
			since,
		}),
		listRunRecords({
			env: input.env,
			userId,
			filter: {
				status: statusFilterToRunStatus(statusFilter),
				surface: surfaceFilterToRunSurface(surfaceFilter),
				since,
				errorTriage: triageFilter,
			},
			limit: defaultPageSize,
			cursor,
		}),
		selectedRunId
			? getRunRecord({
					env: input.env,
					userId,
					runId: selectedRunId,
				})
			: Promise.resolve(null),
	])

	return {
		ok: true,
		statusFilter,
		surfaceFilter,
		triageFilter,
		summary: {
			since: summary.since,
			total: summary.total,
			errors: summary.errors,
			ignored: summary.ignored,
			resolved: summary.resolved,
			running: summary.running,
		},
		runs: page.runs.map(toListItem),
		nextCursor: page.nextCursor,
		selectedRun: selectedRecord
			? toDetail(selectedRecord.run, selectedRecord.logs)
			: null,
		selectedRunId,
		retentionDays: runRecordRetentionDays,
	}
}
