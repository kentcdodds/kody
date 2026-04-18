import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	createJob: vi.fn(),
	updateJob: vi.fn(),
	syncJobManagerAlarm: vi.fn(),
}))

vi.mock('#worker/jobs/service.ts', () => ({
	createJob: (...args: Array<unknown>) => mockModule.createJob(...args),
	updateJob: (...args: Array<unknown>) => mockModule.updateJob(...args),
}))

vi.mock('#worker/jobs/manager-do.ts', () => ({
	syncJobManagerAlarm: (...args: Array<unknown>) =>
		mockModule.syncJobManagerAlarm(...args),
}))

const { jobUpsertCapability } = await import('./job-upsert.ts')

test('job_upsert forwards repo-backed fields on create', async () => {
	mockModule.createJob.mockReset()
	mockModule.updateJob.mockReset()
	mockModule.syncJobManagerAlarm.mockReset()
	mockModule.createJob.mockResolvedValueOnce({
		version: 1,
		id: 'job-1',
		name: 'Repo-backed create',
		code: null,
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		storageId: 'job:job-1',
		schedule: { type: 'interval', every: '15m' },
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-17T00:00:00.000Z',
		updatedAt: '2026-04-17T00:00:00.000Z',
		nextRunAt: '2026-04-17T00:15:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
		scheduleSummary: 'Runs every 15m',
	})

	await jobUpsertCapability.handler(
		{
			name: 'Repo-backed create',
			code: null,
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			schedule: { type: 'interval', every: '15m' },
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-1', email: 'user@example.com' },
			}),
		},
	)

	expect(mockModule.createJob).toHaveBeenCalledWith({
		env: {},
		callerContext: expect.objectContaining({
			baseUrl: 'https://heykody.dev',
		}),
		body: {
			code: null,
			name: 'Repo-backed create',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			schedule: { type: 'interval', every: '15m' },
		},
	})
})

test('job_upsert forwards repo-backed fields on update', async () => {
	mockModule.createJob.mockReset()
	mockModule.updateJob.mockReset()
	mockModule.syncJobManagerAlarm.mockReset()
	mockModule.updateJob.mockResolvedValueOnce({
		version: 1,
		id: 'job-1',
		name: 'Repo-backed update',
		code: null,
		sourceId: 'source-1',
		publishedCommit: 'commit-2',
		storageId: 'job:job-1',
		schedule: { type: 'interval', every: '15m' },
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-17T00:00:00.000Z',
		updatedAt: '2026-04-17T00:05:00.000Z',
		nextRunAt: '2026-04-17T00:15:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
		scheduleSummary: 'Runs every 15m',
	})

	await jobUpsertCapability.handler(
		{
			id: 'job-1',
			sourceId: 'source-1',
			publishedCommit: 'commit-2',
			code: null,
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-1', email: 'user@example.com' },
			}),
		},
	)

	expect(mockModule.updateJob).toHaveBeenCalledWith({
		env: {},
		callerContext: expect.objectContaining({
			baseUrl: 'https://heykody.dev',
		}),
		body: {
			id: 'job-1',
			code: null,
			sourceId: 'source-1',
			publishedCommit: 'commit-2',
		},
	})
	expect(mockModule.updateJob.mock.calls[0]?.[0]).toEqual(
		expect.not.objectContaining({
			body: expect.objectContaining({
				repoCheckPolicy: expect.anything(),
			}),
		}),
	)
})

test('job_upsert forwards repo check policy on create', async () => {
	mockModule.createJob.mockReset()
	mockModule.updateJob.mockReset()
	mockModule.syncJobManagerAlarm.mockReset()
	mockModule.createJob.mockResolvedValueOnce({
		version: 1,
		id: 'job-2',
		name: 'Repo-backed create with policy',
		code: null,
		sourceId: 'source-2',
		publishedCommit: 'commit-2',
		repoCheckPolicy: {
			allowTypecheckFailures: true,
		},
		storageId: 'job:job-2',
		schedule: { type: 'interval', every: '15m' },
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-17T00:00:00.000Z',
		updatedAt: '2026-04-17T00:00:00.000Z',
		nextRunAt: '2026-04-17T00:15:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
		scheduleSummary: 'Runs every 15m',
	})

	await jobUpsertCapability.handler(
		{
			name: 'Repo-backed create with policy',
			code: null,
			sourceId: 'source-2',
			publishedCommit: 'commit-2',
			repoCheckPolicy: {
				allowTypecheckFailures: true,
			},
			schedule: { type: 'interval', every: '15m' },
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-1', email: 'user@example.com' },
			}),
		},
	)

	expect(mockModule.createJob).toHaveBeenCalledWith({
		env: {},
		callerContext: expect.objectContaining({
			baseUrl: 'https://heykody.dev',
		}),
		body: expect.objectContaining({
			name: 'Repo-backed create with policy',
			sourceId: 'source-2',
			publishedCommit: 'commit-2',
			repoCheckPolicy: {
				allowTypecheckFailures: true,
			},
		}),
	})
})
