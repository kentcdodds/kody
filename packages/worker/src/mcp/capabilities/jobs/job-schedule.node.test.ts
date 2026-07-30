import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	createJob: vi.fn(),
	deleteJob: vi.fn(),
	getJobInspection: vi.fn(),
	inspectJobsForUser: vi.fn(),
	listRunRecords: vi.fn(),
	listWorkflowRunsForUser: vi.fn(),
	runJobNowViaManager: vi.fn(),
	updateJob: vi.fn(),
}))

vi.mock('#worker/jobs/service.ts', () => ({
	createJob: (...args: Array<unknown>) => mockModule.createJob(...args),
	deleteJob: (...args: Array<unknown>) => mockModule.deleteJob(...args),
	updateJob: (...args: Array<unknown>) => mockModule.updateJob(...args),
}))

vi.mock('#worker/jobs/inspect.ts', () => ({
	getJobInspection: (...args: Array<unknown>) =>
		mockModule.getJobInspection(...args),
	inspectJobsForUser: (...args: Array<unknown>) =>
		mockModule.inspectJobsForUser(...args),
}))

vi.mock('#worker/jobs/manager-client.ts', () => ({
	runJobNowViaManager: (...args: Array<unknown>) =>
		mockModule.runJobNowViaManager(...args),
}))

vi.mock('#worker/package-runtime/package-workflows.ts', () => ({
	listWorkflowRunsForUser: (...args: Array<unknown>) =>
		mockModule.listWorkflowRunsForUser(...args),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: (...args: Array<unknown>) =>
		mockModule.listRunRecords(...args),
}))

const { jobScheduleCapability } = await import('./job-schedule.ts')
const { jobScheduleOnceCapability } = await import('./job-schedule-once.ts')
const { jobDeleteCapability } = await import('./job-delete.ts')
const { jobGetCapability } = await import('./job-get.ts')
const { jobListCapability } = await import('./job-list.ts')
const { jobRunNowCapability } = await import('./job-run-now.ts')
const { jobUpdateCapability } = await import('./job-update.ts')
const { workflowListCapability } = await import('./workflow-list.ts')

function resetMocks() {
	mockModule.createJob.mockReset()
	mockModule.deleteJob.mockReset()
	mockModule.getJobInspection.mockReset()
	mockModule.inspectJobsForUser.mockReset()
	mockModule.listRunRecords.mockReset()
	mockModule.listWorkflowRunsForUser.mockReset()
	mockModule.runJobNowViaManager.mockReset()
	mockModule.updateJob.mockReset()
	mockModule.listRunRecords.mockResolvedValue({ runs: [], nextCursor: null })
}

test('job_update and job_delete require authentication and mutate existing jobs for the signed-in user', async () => {
	resetMocks()
	const env = {} as Env
	const unauthenticatedContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
	})

	await expect(
		jobUpdateCapability.handler(
			{
				id: 'job-123',
				enabled: false,
			},
			{
				env,
				callerContext: unauthenticatedContext,
			},
		),
	).rejects.toThrow('Authenticated MCP user is required for this capability.')
	await expect(
		jobDeleteCapability.handler(
			{
				id: 'job-123',
			},
			{
				env,
				callerContext: unauthenticatedContext,
			},
		),
	).rejects.toThrow('Authenticated MCP user is required for this capability.')
	await expect(
		jobRunNowCapability.handler(
			{
				id: 'job-123',
			},
			{
				env,
				callerContext: unauthenticatedContext,
			},
		),
	).rejects.toThrow('Authenticated MCP user is required for this capability.')
	expect(mockModule.updateJob).not.toHaveBeenCalled()
	expect(mockModule.deleteJob).not.toHaveBeenCalled()
	expect(mockModule.runJobNowViaManager).not.toHaveBeenCalled()

	const signedInContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'user@example.com',
			displayName: 'User Example',
		},
	})
	mockModule.updateJob.mockResolvedValue({
		id: 'job-123',
		name: 'Nightly cleanup v2',
		sourceId: 'source-123',
		publishedCommit: 'commit-456',
		storageId: 'job:job-123',
		params: {
			room: 'office',
		},
		schedule: {
			type: 'cron',
			expression: '0 3 * * *',
		},
		scheduleSummary: 'Runs on cron "0 3 * * *" in America/Denver',
		timezone: 'America/Denver',
		enabled: false,
		killSwitchEnabled: true,
		preserved: false,
		createdAt: '2026-04-20T10:00:00.000Z',
		updatedAt: '2026-04-20T12:00:00.000Z',
		nextRunAt: '2026-04-21T09:00:00.000Z',
		runCount: 2,
		successCount: 1,
		errorCount: 1,
		runHistory: [
			{
				startedAt: '2026-04-20T11:00:00.000Z',
				finishedAt: '2026-04-20T11:01:00.000Z',
				status: 'error',
				durationMs: 60000,
				error: 'Timed out',
			},
		],
	})

	const result = await jobUpdateCapability.handler(
		{
			id: 'job-123',
			name: 'Nightly cleanup v2',
			code: 'export default async () => ({ ok: true, updated: true })',
			params: {
				room: 'office',
			},
			schedule: {
				type: 'cron',
				expression: '0 3 * * *',
			},
			timezone: 'America/Denver',
			enabled: false,
			kill_switch_enabled: true,
		},
		{
			env,
			callerContext: signedInContext,
		},
	)

	expect(mockModule.updateJob).toHaveBeenCalledWith({
		env,
		callerContext: signedInContext,
		body: {
			id: 'job-123',
			name: 'Nightly cleanup v2',
			code: 'export default async () => ({ ok: true, updated: true })',
			params: {
				room: 'office',
			},
			schedule: {
				type: 'cron',
				expression: '0 3 * * *',
			},
			timezone: 'America/Denver',
			enabled: false,
			killSwitchEnabled: true,
		},
	})
	expect(result).toMatchObject({
		job_id: 'job-123',
		name: 'Nightly cleanup v2',
		source_id: 'source-123',
		published_commit: 'commit-456',
		storage_id: 'job:job-123',
		params: {
			room: 'office',
		},
		schedule: {
			type: 'cron',
			expression: '0 3 * * *',
		},
		timezone: 'America/Denver',
		enabled: false,
		kill_switch_enabled: true,
		preserved: false,
		created_at: '2026-04-20T10:00:00.000Z',
		updated_at: '2026-04-20T12:00:00.000Z',
		next_run_at: '2026-04-21T09:00:00.000Z',
		run_count: 2,
		success_count: 1,
		error_count: 1,
		run_history: [],
	})

	mockModule.updateJob.mockResolvedValueOnce({
		id: 'job-once',
		name: 'One-off cleanup',
		sourceId: 'source-once',
		publishedCommit: null,
		storageId: 'job:job-once',
		schedule: {
			type: 'once',
			runAt: '2026-04-22T18:30:00Z',
		},
		scheduleSummary: 'Runs once at 2026-04-22T18:30:00Z',
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		preserved: false,
		createdAt: '2026-04-20T10:00:00.000Z',
		updatedAt: '2026-04-20T12:00:00.000Z',
		nextRunAt: '2026-04-22T18:30:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
	})
	await jobUpdateCapability.handler(
		{
			id: 'job-once',
			schedule: {
				type: 'once',
				run_at: '2026-04-22T18:30:00Z',
			},
		},
		{ env, callerContext: signedInContext },
	)
	expect(mockModule.updateJob).toHaveBeenLastCalledWith({
		env,
		callerContext: signedInContext,
		body: expect.objectContaining({
			id: 'job-once',
			schedule: {
				type: 'once',
				runAt: '2026-04-22T18:30:00Z',
			},
		}),
	})
	expect(
		mockModule.updateJob.mock.calls.at(-1)?.[0].body.schedule,
	).not.toHaveProperty('run_at')

	await expect(
		jobUpdateCapability.handler(
			{
				id: 'job-123',
			},
			{
				env,
				callerContext: signedInContext,
			},
		),
	).rejects.toThrow('Provide at least one mutable field to update.')
	expect(mockModule.updateJob).toHaveBeenCalledTimes(2)

	mockModule.deleteJob.mockResolvedValue({
		id: 'job-123',
		deleted: true,
	})
	const deleteResult = await jobDeleteCapability.handler(
		{
			id: 'job-123',
		},
		{
			env,
			callerContext: signedInContext,
		},
	)
	expect(mockModule.deleteJob).toHaveBeenCalledWith({
		env,
		userId: 'user-123',
		jobId: 'job-123',
	})
	expect(deleteResult).toEqual({
		job_id: 'job-123',
		deleted: true,
	})
})

test('job_run_now executes jobs immediately and preserves failed one-off jobs for inspection', async () => {
	resetMocks()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'user@example.com',
			displayName: 'User Example',
		},
		storageContext: {
			sessionId: null,
			appId: 'app-123',
		},
	})
	mockModule.runJobNowViaManager.mockResolvedValueOnce({
		job: {
			id: 'job-123',
			name: 'Immediate run',
			sourceId: 'source-123',
			publishedCommit: 'commit-123',
			storageId: 'job:job-123',
			params: {
				room: 'office',
			},
			schedule: {
				type: 'interval',
				every: '15m',
			},
			scheduleSummary: 'Runs every 15m',
			timezone: 'UTC',
			enabled: true,
			killSwitchEnabled: false,
			preserved: false,
			createdAt: '2026-04-20T10:00:00.000Z',
			updatedAt: '2026-04-20T10:05:00.000Z',
			lastRunAt: '2026-04-20T10:05:00.000Z',
			lastRunStatus: 'success',
			lastDurationMs: 42,
			nextRunAt: '2026-04-20T10:20:00.000Z',
			runCount: 1,
			successCount: 1,
			errorCount: 0,
			runHistory: [
				{
					startedAt: '2026-04-20T10:05:00.000Z',
					finishedAt: '2026-04-20T10:05:00.000Z',
					status: 'success',
					durationMs: 42,
				},
			],
		},
		execution: {
			ok: true,
			result: { ok: true },
			logs: ['ran job'],
		},
		deletedAfterRun: false,
	})

	const successResult = await jobRunNowCapability.handler(
		{
			id: 'job-123',
		},
		{
			env,
			callerContext,
		},
	)

	expect(mockModule.runJobNowViaManager).toHaveBeenCalledWith({
		env,
		userId: 'user-123',
		jobId: 'job-123',
		callerContext,
	})
	expect(successResult).toMatchObject({
		job: {
			job_id: 'job-123',
			name: 'Immediate run',
			source_id: 'source-123',
			published_commit: 'commit-123',
			storage_id: 'job:job-123',
			params: {
				room: 'office',
			},
			schedule: {
				type: 'interval',
				every: '15m',
			},
			timezone: 'UTC',
			enabled: true,
			kill_switch_enabled: false,
			created_at: '2026-04-20T10:00:00.000Z',
			updated_at: '2026-04-20T10:05:00.000Z',
			last_run_at: '2026-04-20T10:05:00.000Z',
			last_run_status: 'success',
			last_duration_ms: 42,
			next_run_at: '2026-04-20T10:20:00.000Z',
			run_count: 1,
			success_count: 1,
			error_count: 0,
			run_history: [],
		},
		execution: {
			ok: true,
			result: { ok: true },
			logs: ['ran job'],
		},
		deleted_after_run: false,
	})

	mockModule.runJobNowViaManager.mockResolvedValueOnce({
		job: {
			id: 'job-once',
			name: 'One-off run',
			sourceId: 'source-once',
			publishedCommit: null,
			storageId: 'job:job-once',
			schedule: {
				type: 'once',
				runAt: '2026-04-20T10:00:00.000Z',
			},
			scheduleSummary: 'Runs once at 2026-04-20T10:00:00.000Z',
			timezone: 'UTC',
			enabled: true,
			killSwitchEnabled: false,
			preserved: false,
			createdAt: '2026-04-20T09:00:00.000Z',
			updatedAt: '2026-04-20T10:00:00.000Z',
			lastRunAt: '2026-04-20T10:00:00.000Z',
			lastRunStatus: 'error',
			lastRunError: 'boom',
			lastDurationMs: 5,
			nextRunAt: '2026-04-20T10:00:00.000Z',
			runCount: 1,
			successCount: 0,
			errorCount: 1,
			runHistory: [
				{
					startedAt: '2026-04-20T10:00:00.000Z',
					finishedAt: '2026-04-20T10:00:00.000Z',
					status: 'error',
					durationMs: 5,
					error: 'boom',
				},
			],
		},
		execution: {
			ok: false,
			error: 'boom',
			logs: ['ran job'],
		},
		deletedAfterRun: false,
	})

	const failedOneOffResult = await jobRunNowCapability.handler(
		{
			id: 'job-once',
		},
		{
			env,
			callerContext,
		},
	)

	expect(failedOneOffResult.deleted_after_run).toBe(false)
	expect(failedOneOffResult.execution).toEqual({
		ok: false,
		error: 'boom',
		logs: ['ran job'],
	})
	expect(failedOneOffResult.job.last_run_error).toBe('boom')
})

test('job_schedule covers recurring schedules, requires auth, and supports the one-off helper flow', async () => {
	resetMocks()
	const env = {} as Env
	const unauthenticatedContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
	})

	await expect(
		jobScheduleCapability.handler(
			{
				code: 'export default async () => ({ ok: true })',
				schedule: {
					type: 'interval',
					every: '15m',
				},
			},
			{
				env,
				callerContext: unauthenticatedContext,
			},
		),
	).rejects.toThrow('Authenticated MCP user is required for this capability.')
	await expect(
		jobScheduleOnceCapability.handler(
			{
				code: 'export default async () => ({ ok: true })',
				run_at: '2026-04-20T18:30:00Z',
			},
			{
				env,
				callerContext: unauthenticatedContext,
			},
		),
	).rejects.toThrow('Authenticated MCP user is required for this capability.')
	expect(mockModule.createJob).not.toHaveBeenCalled()

	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'user@example.com',
			displayName: 'User Example',
		},
	})
	mockModule.createJob
		.mockResolvedValueOnce({
			id: 'job-interval',
			name: 'Nightly cleanup',
			sourceId: 'source-interval',
			storageId: 'job:job-interval',
			schedule: {
				type: 'interval',
				every: '15m',
			},
			scheduleSummary: 'Runs every 15m',
			createdAt: '2026-04-20T10:00:00.000Z',
			nextRunAt: '2026-04-20T10:15:00.000Z',
		} as const)
		.mockResolvedValueOnce({
			id: 'job-cron',
			name: 'Weekly digest',
			sourceId: 'source-cron',
			storageId: 'job:job-cron',
			schedule: {
				type: 'cron',
				expression: '0 9 * * 1',
			},
			scheduleSummary: 'Runs on cron "0 9 * * 1" in America/Denver',
			createdAt: '2026-04-20T10:00:00.000Z',
			nextRunAt: '2026-04-27T15:00:00.000Z',
		} as const)
		.mockResolvedValueOnce({
			id: 'job-once',
			name: 'One-off job',
			sourceId: 'source-once',
			storageId: 'job:job-once',
			schedule: {
				type: 'once',
				runAt: '2026-04-20T18:30:00.000Z',
			},
			scheduleSummary: 'Runs once at 2026-04-20T18:30:00.000Z',
			createdAt: '2026-04-20T10:00:00.000Z',
			nextRunAt: '2026-04-20T18:30:00.000Z',
		} as const)

	const intervalResult = await jobScheduleCapability.handler(
		{
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
		{
			env,
			callerContext,
		},
	)
	const cronResult = await jobScheduleCapability.handler(
		{
			name: 'Weekly digest',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'cron',
				expression: '0 9 * * 1',
			},
			timezone: 'America/Denver',
		},
		{
			env,
			callerContext,
		},
	)
	const oneOffResult = await jobScheduleOnceCapability.handler(
		{
			code: 'export default async () => ({ ok: true })',
			run_at: '2026-04-20T18:30:00Z',
		},
		{
			env,
			callerContext,
		},
	)

	expect(mockModule.createJob).toHaveBeenNthCalledWith(1, {
		env,
		callerContext,
		body: {
			name: 'Scheduled job',
			code: 'export default async () => ({ ok: true })',
			params: undefined,
			schedule: {
				type: 'interval',
				every: '15m',
			},
			timezone: null,
		},
	})
	expect(intervalResult).toMatchObject({
		job_id: 'job-interval',
		schedule: {
			type: 'interval',
			every: '15m',
		},
		next_run_at: '2026-04-20T10:15:00.000Z',
	})

	expect(mockModule.createJob).toHaveBeenNthCalledWith(2, {
		env,
		callerContext,
		body: {
			name: 'Weekly digest',
			code: 'export default async () => ({ ok: true })',
			params: undefined,
			schedule: {
				type: 'cron',
				expression: '0 9 * * 1',
			},
			timezone: 'America/Denver',
		},
	})
	expect(cronResult).toMatchObject({
		job_id: 'job-cron',
		schedule: {
			type: 'cron',
			expression: '0 9 * * 1',
		},
		next_run_at: '2026-04-27T15:00:00.000Z',
	})

	expect(mockModule.createJob).toHaveBeenNthCalledWith(3, {
		env,
		callerContext,
		body: {
			name: 'One-off job',
			code: 'export default async () => ({ ok: true })',
			params: undefined,
			schedule: {
				type: 'once',
				runAt: '2026-04-20T18:30:00Z',
			},
			timezone: null,
		},
	})
	expect(oneOffResult).toMatchObject({
		job_id: 'job-once',
		schedule: {
			type: 'once',
			run_at: '2026-04-20T18:30:00.000Z',
		},
	})
})

test('job inspection capabilities expose due-now state, history, alarm status, optional source code, and workflow runs', async () => {
	resetMocks()
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-04-20T18:30:00.000Z'))
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'user@example.com',
			displayName: 'User Example',
		},
	})
	mockModule.inspectJobsForUser.mockResolvedValue({
		jobs: [
			{
				id: 'job-123',
				name: 'Turn lights off',
				sourceId: 'source-123',
				publishedCommit: 'commit-123',
				storageId: 'job:job-123',
				schedule: {
					type: 'once',
					runAt: '2026-04-20T18:30:00.000Z',
				},
				scheduleSummary: 'Runs once at 2026-04-20T18:30:00.000Z',
				timezone: 'UTC',
				enabled: true,
				killSwitchEnabled: false,
				preserved: false,
				createdAt: '2026-04-20T10:00:00.000Z',
				updatedAt: '2026-04-20T10:05:00.000Z',
				nextRunAt: '2026-04-20T18:30:00.000Z',
				runCount: 0,
				successCount: 0,
				errorCount: 0,
				runHistory: [],
			},
		],
		alarm: {
			bindingAvailable: true,
			status: 'armed',
			storedUserId: 'user-123',
			alarmScheduledFor: '2026-04-20T18:30:00.000Z',
			nextRunnableJobId: 'job-123',
			nextRunnableRunAt: '2026-04-20T18:30:00.000Z',
			alarmInSync: true,
		},
	})
	mockModule.getJobInspection.mockResolvedValue({
		job: {
			id: 'job-123',
			name: 'Turn lights off',
			sourceId: 'source-123',
			publishedCommit: null,
			storageId: 'job:job-123',
			params: {
				bridgeId: 'ZPGI01117',
			},
			schedule: {
				type: 'once',
				runAt: '2026-04-20T18:30:00.000Z',
			},
			scheduleSummary: 'Runs once at 2026-04-20T18:30:00.000Z',
			timezone: 'UTC',
			enabled: true,
			killSwitchEnabled: false,
			preserved: false,
			createdAt: '2026-04-20T10:00:00.000Z',
			updatedAt: '2026-04-20T10:05:00.000Z',
			nextRunAt: '2026-04-20T18:30:00.000Z',
			lastRunAt: '2026-04-20T09:00:00.000Z',
			lastRunStatus: 'error',
			lastRunError: 'Timed out',
			lastDurationMs: 1200,
			runCount: 2,
			successCount: 1,
			errorCount: 1,
			runHistory: [],
		},
		alarm: {
			bindingAvailable: true,
			status: 'out_of_sync',
			storedUserId: 'user-123',
			alarmScheduledFor: '2026-04-20T19:00:00.000Z',
			nextRunnableJobId: 'job-123',
			nextRunnableRunAt: '2026-04-20T18:30:00.000Z',
			alarmInSync: false,
		},
	})
	mockModule.listRunRecords.mockResolvedValue({
		runs: [
			{
				id: 'run-err-1',
				surface: 'job',
				status: 'error',
				name: 'Turn lights off',
				packageId: null,
				kodyId: null,
				sourceId: 'source-123',
				publishedCommit: null,
				storageId: 'job:job-123',
				jobId: 'job-123',
				workflowId: null,
				invocationId: null,
				sessionId: null,
				idempotencyKey: null,
				parentRunId: null,
				startedAt: '2026-04-20T08:59:58.000Z',
				finishedAt: '2026-04-20T09:00:00.000Z',
				durationMs: 1200,
				errorName: 'Error',
				errorMessage: 'Timed out',
				metadata: {},
				logCount: 2,
			},
		],
		nextCursor: null,
	})

	try {
		const listResult = await jobListCapability.handler(
			{},
			{
				env,
				callerContext,
			},
		)
		expect(mockModule.listRunRecords).not.toHaveBeenCalled()
		const getResult = await jobGetCapability.handler(
			{ id: 'job-123' },
			{
				env,
				callerContext,
			},
		)

		expect(mockModule.inspectJobsForUser).toHaveBeenCalledWith({
			env,
			userId: 'user-123',
		})
		expect(listResult.jobs).toHaveLength(1)
		expect(listResult.jobs[0]).toMatchObject({
			id: 'job-123',
			source_id: 'source-123',
			published_commit: 'commit-123',
			due_now: true,
			recent_runs: [],
		})
		expect(listResult.alarm).toEqual({
			binding_available: true,
			status: 'armed',
			stored_user_id: 'user-123',
			alarm_scheduled_for: '2026-04-20T18:30:00.000Z',
			next_runnable_job_id: 'job-123',
			next_runnable_run_at: '2026-04-20T18:30:00.000Z',
			alarm_in_sync: true,
		})

		expect(mockModule.getJobInspection).toHaveBeenCalledWith({
			env,
			userId: 'user-123',
			jobId: 'job-123',
			includeCode: false,
		})
		expect(mockModule.listRunRecords).toHaveBeenCalledWith({
			env,
			userId: 'user-123',
			filter: { jobId: 'job-123', surface: 'job' },
			limit: 10,
		})
		expect(getResult.job).toMatchObject({
			id: 'job-123',
			source_id: 'source-123',
			params: {
				bridgeId: 'ZPGI01117',
			},
			due_now: true,
			last_run_status: 'error',
			last_run_error: 'Timed out',
			last_duration_ms: 1200,
			recent_runs: [
				{
					id: 'run-err-1',
					started_at: '2026-04-20T08:59:58.000Z',
					finished_at: '2026-04-20T09:00:00.000Z',
					status: 'error',
					duration_ms: 1200,
					error: 'Timed out',
				},
			],
		})
		expect(getResult.alarm).toEqual({
			binding_available: true,
			status: 'out_of_sync',
			stored_user_id: 'user-123',
			alarm_scheduled_for: '2026-04-20T19:00:00.000Z',
			next_runnable_job_id: 'job-123',
			next_runnable_run_at: '2026-04-20T18:30:00.000Z',
			alarm_in_sync: false,
		})

		const sourceCode =
			'export default async function main() { return { ok: true } }'
		mockModule.getJobInspection.mockResolvedValue({
			job: {
				id: 'job-123',
				name: 'Inspect source',
				sourceId: 'source-123',
				publishedCommit: 'commit-123',
				storageId: 'job:job-123',
				schedule: {
					type: 'interval',
					every: '15m',
				},
				scheduleSummary: 'Runs every 15m',
				timezone: 'UTC',
				enabled: true,
				killSwitchEnabled: false,
				preserved: false,
				createdAt: '2026-04-20T10:00:00.000Z',
				updatedAt: '2026-04-20T10:05:00.000Z',
				nextRunAt: '2026-04-20T18:30:00.000Z',
				runCount: 0,
				successCount: 0,
				errorCount: 0,
				runHistory: [],
			},
			alarm: {
				bindingAvailable: true,
				status: 'armed',
				storedUserId: 'user-123',
				alarmScheduledFor: '2026-04-20T18:30:00.000Z',
				nextRunnableJobId: 'job-123',
				nextRunnableRunAt: '2026-04-20T18:30:00.000Z',
				alarmInSync: true,
			},
			source: {
				entrypoint: 'src/custom-job.ts',
				code: sourceCode,
				error: null,
			},
		})
		mockModule.listRunRecords.mockResolvedValue({
			runs: [],
			nextCursor: null,
		})

		const sourceResult = await jobGetCapability.handler(
			{ job_id: 'job-123', includeCode: true },
			{
				env,
				callerContext,
			},
		)
		expect(mockModule.getJobInspection).toHaveBeenLastCalledWith({
			env,
			userId: 'user-123',
			jobId: 'job-123',
			includeCode: true,
		})
		expect(sourceResult.source).toEqual({
			entrypoint: 'src/custom-job.ts',
			code: sourceCode,
			error: null,
		})

		mockModule.listWorkflowRunsForUser.mockResolvedValue([
			{
				id: 'dynwf-123',
				userId: 'user-123',
				sourceType: 'inline',
				packageId: null,
				kodyId: null,
				sourceId: null,
				workflowName: 'inline-code',
				exportName: null,
				idempotencyKey: 'execute-smoke',
				runAt: '2026-05-03T12:00:00.000Z',
				planDate: '2026-05-03',
				status: 'complete',
				createdAt: '2026-05-03T11:59:00.000Z',
				updatedAt: '2026-05-03T12:00:01.000Z',
				completedAt: '2026-05-03T12:00:01.000Z',
				lastError: null,
			},
		])

		const workflowListResult = await workflowListCapability.handler(
			{ limit: 5 },
			{ env, callerContext },
		)
		expect(mockModule.listWorkflowRunsForUser).toHaveBeenCalledWith({
			env,
			userId: 'user-123',
			limit: 5,
		})
		expect(workflowListResult.workflows).toEqual([
			{
				id: 'dynwf-123',
				source_type: 'inline',
				package_id: null,
				kody_id: null,
				source_id: null,
				workflow_name: 'inline-code',
				export_name: null,
				idempotency_key: 'execute-smoke',
				run_at: '2026-05-03T12:00:00.000Z',
				plan_date: '2026-05-03',
				status: 'complete',
				created_at: '2026-05-03T11:59:00.000Z',
				updated_at: '2026-05-03T12:00:01.000Z',
				completed_at: '2026-05-03T12:00:01.000Z',
				last_error: null,
			},
		])
	} finally {
		vi.useRealTimers()
	}
})
