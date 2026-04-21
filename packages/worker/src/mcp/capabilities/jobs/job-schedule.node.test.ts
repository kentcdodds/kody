import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { jobsDomain } from './domain.ts'

const mockModule = vi.hoisted(() => ({
	createJob: vi.fn(),
	syncJobManagerAlarm: vi.fn(),
	runJobNowViaManager: vi.fn(),
}))

vi.mock('#worker/jobs/service.ts', () => ({
	createJob: (...args: Array<unknown>) => mockModule.createJob(...args),
}))

vi.mock('#worker/jobs/manager-client.ts', () => ({
	syncJobManagerAlarm: (...args: Array<unknown>) =>
		mockModule.syncJobManagerAlarm(...args),
	runJobNowViaManager: (...args: Array<unknown>) =>
		mockModule.runJobNowViaManager(...args),
}))

const { jobScheduleCapability } = await import('./job-schedule.ts')
const { jobScheduleOnceCapability } = await import('./job-schedule-once.ts')
const { jobRunNowCapability } = await import('./job-run-now.ts')

function resetMocks() {
	mockModule.createJob.mockReset()
	mockModule.syncJobManagerAlarm.mockReset()
	mockModule.runJobNowViaManager.mockReset()
	mockModule.syncJobManagerAlarm.mockResolvedValue(undefined)
}

test('job_schedule creates a one-off job and syncs the job manager alarm', async () => {
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
	mockModule.createJob.mockResolvedValue({
		id: 'job-123',
		name: 'Turn lights off',
		sourceId: 'source-123',
		storageId: 'job:job-123',
		schedule: {
			type: 'once',
			runAt: '2026-04-20T18:30:00.000Z',
		},
		scheduleSummary: 'Runs once at 2026-04-20T18:30:00.000Z',
		createdAt: '2026-04-20T10:00:00.000Z',
		nextRunAt: '2026-04-20T18:30:00.000Z',
	} as const)

	const result = await jobScheduleCapability.handler(
		{
			name: 'Turn lights off',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'once',
				run_at: '2026-04-20T18:30:00Z',
			},
			params: {
				room: 'office',
			},
			timezone: 'America/Denver',
		},
		{
			env,
			callerContext,
		},
	)

	expect(mockModule.createJob).toHaveBeenCalledWith({
		env,
		callerContext,
		body: {
			name: 'Turn lights off',
			code: 'export default async () => ({ ok: true })',
			params: {
				room: 'office',
			},
			schedule: {
				type: 'once',
				runAt: '2026-04-20T18:30:00Z',
			},
			timezone: 'America/Denver',
		},
	})
	expect(mockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: 'user-123',
	})
	expect(result).toEqual({
		job_id: 'job-123',
		name: 'Turn lights off',
		source_id: 'source-123',
		storage_id: 'job:job-123',
		schedule: {
			type: 'once',
			run_at: '2026-04-20T18:30:00.000Z',
		},
		schedule_summary: 'Runs once at 2026-04-20T18:30:00.000Z',
		created_at: '2026-04-20T10:00:00.000Z',
		next_run_at: '2026-04-20T18:30:00.000Z',
	})
})

test('jobs domain exposes recurring and one-off scheduling capabilities', () => {
	expect(jobsDomain.capabilities.map((capability) => capability.name)).toEqual(
		expect.arrayContaining([
			'job_schedule',
			'job_schedule_once',
			'job_run_now',
		]),
	)
})

test('job_run_now executes an existing job through the job manager', async () => {
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
	mockModule.runJobNowViaManager.mockResolvedValue({
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
	})

	const result = await jobRunNowCapability.handler(
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
	expect(result).toEqual({
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
			schedule_summary: 'Runs every 15m',
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
			run_history: [
				{
					started_at: '2026-04-20T10:05:00.000Z',
					finished_at: '2026-04-20T10:05:00.000Z',
					status: 'success',
					duration_ms: 42,
				},
			],
		},
		execution: {
			ok: true,
			result: { ok: true },
			logs: ['ran job'],
		},
		deleted_after_run: false,
	})
})

test('job_run_now reports one-off jobs as deleted after the run', async () => {
	resetMocks()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'user@example.com',
			displayName: 'User Example',
		},
	})
	mockModule.runJobNowViaManager.mockResolvedValue({
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
	})

	const result = await jobRunNowCapability.handler(
		{
			id: 'job-once',
		},
		{
			env,
			callerContext,
		},
	)

	expect(result.deleted_after_run).toBe(true)
	expect(result.execution).toEqual({
		ok: false,
		error: 'boom',
		logs: ['ran job'],
	})
	expect(result.job.last_run_error).toBe('boom')
})

test('job_schedule creates a recurring interval job', async () => {
	resetMocks()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'user@example.com',
			displayName: 'User Example',
		},
	})
	mockModule.createJob.mockResolvedValue({
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

	const result = await jobScheduleCapability.handler(
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

	expect(mockModule.createJob).toHaveBeenCalledWith({
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
	expect(result).toEqual({
		job_id: 'job-interval',
		name: 'Nightly cleanup',
		source_id: 'source-interval',
		storage_id: 'job:job-interval',
		schedule: {
			type: 'interval',
			every: '15m',
		},
		schedule_summary: 'Runs every 15m',
		created_at: '2026-04-20T10:00:00.000Z',
		next_run_at: '2026-04-20T10:15:00.000Z',
	})
})

test('job_schedule creates a recurring cron job', async () => {
	resetMocks()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'user@example.com',
			displayName: 'User Example',
		},
	})
	mockModule.createJob.mockResolvedValue({
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

	const result = await jobScheduleCapability.handler(
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

	expect(mockModule.createJob).toHaveBeenCalledWith({
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
	expect(result).toEqual({
		job_id: 'job-cron',
		name: 'Weekly digest',
		source_id: 'source-cron',
		storage_id: 'job:job-cron',
		schedule: {
			type: 'cron',
			expression: '0 9 * * 1',
		},
		schedule_summary: 'Runs on cron "0 9 * * 1" in America/Denver',
		created_at: '2026-04-20T10:00:00.000Z',
		next_run_at: '2026-04-27T15:00:00.000Z',
	})
})

test('job_schedule_once delegates to the general scheduling capability', async () => {
	resetMocks()
	const env = {} as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'user@example.com',
			displayName: 'User Example',
		},
	})
	mockModule.createJob.mockResolvedValue({
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

	await jobScheduleOnceCapability.handler(
		{
			code: 'export default async () => ({ ok: true })',
			run_at: '2026-04-20T18:30:00Z',
		},
		{
			env,
			callerContext,
		},
	)

	expect(mockModule.createJob).toHaveBeenCalledWith({
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
})

test('job_schedule requires an authenticated user', async () => {
	resetMocks()
	const env = {} as Env

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
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
				}),
			},
		),
	).rejects.toThrow('Authenticated MCP user is required for this capability.')
	expect(mockModule.createJob).not.toHaveBeenCalled()
	expect(mockModule.syncJobManagerAlarm).not.toHaveBeenCalled()
})

test('job_run_now requires an authenticated user', async () => {
	resetMocks()
	const env = {} as Env

	await expect(
		jobRunNowCapability.handler(
			{
				id: 'job-123',
			},
			{
				env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
				}),
			},
		),
	).rejects.toThrow('Authenticated MCP user is required for this capability.')
	expect(mockModule.runJobNowViaManager).not.toHaveBeenCalled()
})
