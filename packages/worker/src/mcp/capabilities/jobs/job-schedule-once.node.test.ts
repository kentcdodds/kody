import { beforeEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	createJob: vi.fn(),
	syncJobManagerAlarm: vi.fn(),
}))

vi.mock('#worker/jobs/service.ts', () => ({
	createJob: (...args: Array<unknown>) => mockModule.createJob(...args),
}))

vi.mock('#worker/jobs/manager-client.ts', () => ({
	syncJobManagerAlarm: (...args: Array<unknown>) =>
		mockModule.syncJobManagerAlarm(...args),
}))

const { jobScheduleOnceCapability } = await import('./job-schedule-once.ts')

beforeEach(() => {
	mockModule.createJob.mockReset()
	mockModule.syncJobManagerAlarm.mockReset()
	mockModule.syncJobManagerAlarm.mockResolvedValue(undefined)
})

test('job_schedule_once creates a one-off job and syncs the job manager alarm', async () => {
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

	const result = await jobScheduleOnceCapability.handler(
		{
			name: 'Turn lights off',
			code: 'export default async () => ({ ok: true })',
			run_at: '2026-04-20T18:30:00Z',
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
		run_at: '2026-04-20T18:30:00.000Z',
		schedule_summary: 'Runs once at 2026-04-20T18:30:00.000Z',
		created_at: '2026-04-20T10:00:00.000Z',
		next_run_at: '2026-04-20T18:30:00.000Z',
	})
})

test('job_schedule_once requires an authenticated user', async () => {
	const env = {} as Env

	await expect(
		jobScheduleOnceCapability.handler(
			{
				code: 'export default async () => ({ ok: true })',
				run_at: '2026-04-20T18:30:00Z',
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
