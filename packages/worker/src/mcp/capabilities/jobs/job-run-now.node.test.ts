import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	runJobNowViaManager: vi.fn(),
}))

vi.mock('#worker/jobs/manager-do.ts', () => ({
	runJobNowViaManager: (...args: Array<unknown>) =>
		mockModule.runJobNowViaManager(...args),
}))

const { jobRunNowCapability } = await import('./job-run-now.ts')

test('job_run_now forwards one-off repo check policy overrides', async () => {
	mockModule.runJobNowViaManager.mockReset()
	mockModule.runJobNowViaManager.mockResolvedValueOnce({
		job: {
			version: 1,
			id: 'job-1',
			name: 'Repo-backed run now',
			code: null,
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			repoCheckPolicy: undefined,
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
		},
		execution: {
			ok: true,
			result: { ok: true },
			logs: [],
		},
	})

	await jobRunNowCapability.handler(
		{
			id: 'job-1',
			repoCheckPolicy: {
				allowTypecheckFailures: true,
			},
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-1', email: 'user@example.com' },
			}),
		},
	)

	expect(mockModule.runJobNowViaManager).toHaveBeenCalledWith({
		env: {},
		userId: 'user-1',
		jobId: 'job-1',
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-1', email: 'user@example.com' },
			homeConnectorId: null,
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
		repoCheckPolicyOverride: {
			allowTypecheckFailures: true,
		},
	})
})
