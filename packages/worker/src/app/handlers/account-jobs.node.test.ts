import { expect, test, vi } from 'vitest'

const adHocJob = {
	id: 'job-adhoc-1',
	name: 'Morning digest',
	sourceId: 'source-1',
	publishedCommit: 'commit-1',
	storageId: 'storage-1',
	params: { topic: 'news' },
	schedule: { type: 'cron' as const, expression: '0 9 * * *' },
	scheduleSummary: 'Runs on cron "0 9 * * *" in UTC',
	timezone: 'UTC',
	enabled: true,
	killSwitchEnabled: false,
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
	nextRunAt: new Date('2026-07-26T09:00:00.000Z').toISOString(),
	lastRunAt: new Date('2026-07-25T09:00:00.000Z').toISOString(),
	lastRunStatus: 'success' as const,
	lastRunError: undefined,
	lastDurationMs: 120,
	runCount: 3,
	successCount: 3,
	errorCount: 0,
	runHistory: [
		{
			startedAt: new Date('2026-07-25T09:00:00.000Z').toISOString(),
			finishedAt: new Date('2026-07-25T09:00:00.120Z').toISOString(),
			status: 'success' as const,
			durationMs: 120,
		},
	],
}

const packageJob = {
	...adHocJob,
	id: 'package-job:pkg-1:nightly',
	name: 'Nightly package job',
	schedule: { type: 'interval' as const, every: '1d' },
	scheduleSummary: 'Runs every 1d',
	params: undefined,
	lastRunStatus: 'error' as const,
	lastRunError: 'boom',
	lastDurationMs: 50,
	runCount: 2,
	successCount: 1,
	errorCount: 1,
	runHistory: [
		{
			startedAt: new Date('2026-07-25T01:00:00.000Z').toISOString(),
			finishedAt: new Date('2026-07-25T01:00:00.050Z').toISOString(),
			status: 'error' as const,
			durationMs: 50,
			error: 'boom',
		},
	],
}

const alarmState = {
	bindingAvailable: true,
	status: 'armed' as const,
	storedUserId: 'stable-user-1',
	alarmScheduledFor: adHocJob.nextRunAt,
	nextRunnableJobId: adHocJob.id,
	nextRunnableRunAt: adHocJob.nextRunAt,
	alarmInSync: true,
}

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(async () => ({
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		displayName: 'user',
		artifactOwnerIds: [],
		mcpUser: {
			userId: 'stable-user-1',
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
	})),
	inspectJobsForUser: vi.fn(),
	updateJob: vi.fn(),
	deleteJob: vi.fn(),
	runJobNowViaManager: vi.fn(),
	getAppBaseUrl: vi.fn(() => 'https://example.com'),
	listRunRecords: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
	redirectToLoginWhenUnauthenticated: () => new Response(null, { status: 302 }),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: async () => new Response('ok'),
}))

vi.mock('#app/app-base-url.ts', () => ({
	getAppBaseUrl: (...args: Array<unknown>) => mockModule.getAppBaseUrl(...args),
}))

vi.mock('#worker/jobs/service.ts', () => ({
	inspectJobsForUser: (...args: Array<unknown>) =>
		mockModule.inspectJobsForUser(...args),
	updateJob: (...args: Array<unknown>) => mockModule.updateJob(...args),
	deleteJob: (...args: Array<unknown>) => mockModule.deleteJob(...args),
}))

vi.mock('#worker/jobs/manager-client.ts', () => ({
	runJobNowViaManager: (...args: Array<unknown>) =>
		mockModule.runJobNowViaManager(...args),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: (...args: Array<unknown>) =>
		mockModule.listRunRecords(...args),
}))

const { createAccountJobsApiHandler } = await import('./account-jobs.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		COOKIE_SECRET: 'secret',
	} as Env
}

function resetInspection(jobs = [adHocJob, packageJob]) {
	mockModule.inspectJobsForUser.mockResolvedValue({
		jobs,
		alarm: alarmState,
	})
	mockModule.listRunRecords.mockImplementation(
		async (input: { filter?: { jobId?: string | null } }) => {
			const jobId = input.filter?.jobId
			const job = jobs.find((entry) => entry.id === jobId)
			return {
				runs: (job?.runHistory ?? []).map((entry, index) => ({
					id: `${jobId}-run-${index}`,
					surface: 'job' as const,
					status: entry.status,
					name: job?.name ?? null,
					packageId: null,
					kodyId: null,
					sourceId: job?.sourceId ?? null,
					publishedCommit: job?.publishedCommit ?? null,
					storageId: job?.storageId ?? null,
					jobId: jobId ?? null,
					workflowId: null,
					invocationId: null,
					sessionId: null,
					idempotencyKey: null,
					parentRunId: null,
					startedAt: entry.startedAt,
					finishedAt: entry.finishedAt,
					durationMs: entry.durationMs,
					errorName: entry.error ? 'Error' : null,
					errorMessage: entry.error ?? null,
					metadata: {},
					logCount: 0,
				})),
				nextCursor: null,
			}
		},
	)
}

test('jobs API lists jobs with ownership and selected detail', async () => {
	resetInspection()
	const handler = createAccountJobsApiHandler(createEnv())

	const listResponse = await handler.handler({
		request: new Request('https://example.com/account/jobs.json'),
	})
	expect(listResponse.status).toBe(200)
	expect(listResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(mockModule.inspectJobsForUser).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: 'stable-user-1',
	})
	await expect(listResponse.json()).resolves.toMatchObject({
		ok: true,
		selectedJobId: null,
		selectedJob: null,
		jobs: [
			expect.objectContaining({
				id: 'job-adhoc-1',
				ownership: 'ad-hoc',
				scheduleSummary: adHocJob.scheduleSummary,
				enabled: true,
				killSwitchEnabled: false,
			}),
			expect.objectContaining({
				id: 'package-job:pkg-1:nightly',
				ownership: 'package',
			}),
		],
		alarm: expect.objectContaining({
			bindingAvailable: true,
			status: 'armed',
		}),
	})

	mockModule.inspectJobsForUser.mockClear()
	resetInspection()
	const detailResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/jobs.json?selected=job-adhoc-1',
		),
	})
	expect(detailResponse.status).toBe(200)
	await expect(detailResponse.json()).resolves.toMatchObject({
		ok: true,
		selectedJobId: 'job-adhoc-1',
		selectedJob: expect.objectContaining({
			id: 'job-adhoc-1',
			ownership: 'ad-hoc',
			params: { topic: 'news' },
			schedule: { type: 'cron', expression: '0 9 * * *' },
			recentRuns: [
				expect.objectContaining({
					id: 'job-adhoc-1-run-0',
					status: 'success',
					durationMs: 120,
					error: null,
				}),
			],
			storageId: 'storage-1',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
		}),
	})
})

test('jobs API set_enabled, update, and delete reject package-owned jobs', async () => {
	resetInspection()
	mockModule.updateJob.mockResolvedValue(packageJob)
	mockModule.deleteJob.mockResolvedValue({ id: packageJob.id, deleted: true })
	const handler = createAccountJobsApiHandler(createEnv())

	const enabledResponse = await handler.handler({
		request: new Request('https://example.com/account/jobs.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'set_enabled',
				id: packageJob.id,
				enabled: false,
			}),
		}),
	})
	expect(enabledResponse.status).toBe(400)
	await expect(enabledResponse.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('Package-owned jobs cannot'),
	})
	expect(mockModule.updateJob).not.toHaveBeenCalled()

	const updateResponse = await handler.handler({
		request: new Request('https://example.com/account/jobs.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'update',
				id: packageJob.id,
				name: 'Nope',
			}),
		}),
	})
	expect(updateResponse.status).toBe(400)
	await expect(updateResponse.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('Package-owned jobs cannot'),
	})
	expect(mockModule.updateJob).not.toHaveBeenCalled()

	const deleteResponse = await handler.handler({
		request: new Request('https://example.com/account/jobs.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'delete',
				id: packageJob.id,
			}),
		}),
	})
	expect(deleteResponse.status).toBe(400)
	await expect(deleteResponse.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('Package-owned jobs cannot'),
	})
	expect(mockModule.deleteJob).not.toHaveBeenCalled()
})

test('jobs API mutations are user-scoped for ad-hoc jobs and kill switch', async () => {
	resetInspection()
	mockModule.updateJob.mockResolvedValue({ ...adHocJob, enabled: false })
	mockModule.deleteJob.mockResolvedValue({ id: adHocJob.id, deleted: true })
	mockModule.runJobNowViaManager.mockResolvedValue({
		job: adHocJob,
		execution: { ok: true, logs: [] },
		deletedAfterRun: false,
	})
	const env = createEnv()
	const handler = createAccountJobsApiHandler(env)

	const disableResponse = await handler.handler({
		request: new Request('https://example.com/account/jobs.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'set_enabled',
				id: adHocJob.id,
				enabled: false,
			}),
		}),
	})
	expect(disableResponse.status).toBe(200)
	expect(mockModule.updateJob).toHaveBeenCalledWith(
		expect.objectContaining({
			env,
			callerContext: expect.objectContaining({
				baseUrl: 'https://example.com',
				user: expect.objectContaining({ userId: 'stable-user-1' }),
			}),
			body: { id: adHocJob.id, enabled: false },
		}),
	)

	mockModule.updateJob.mockClear()
	resetInspection()
	mockModule.updateJob.mockResolvedValue({
		...packageJob,
		killSwitchEnabled: true,
	})
	const killSwitchResponse = await handler.handler({
		request: new Request('https://example.com/account/jobs.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'set_kill_switch',
				id: packageJob.id,
				killSwitchEnabled: true,
			}),
		}),
	})
	expect(killSwitchResponse.status).toBe(200)
	expect(mockModule.updateJob).toHaveBeenCalledWith(
		expect.objectContaining({
			body: { id: packageJob.id, killSwitchEnabled: true },
		}),
	)

	mockModule.updateJob.mockClear()
	resetInspection()
	mockModule.updateJob.mockResolvedValue({
		...adHocJob,
		name: 'Renamed',
		timezone: 'America/Denver',
		schedule: { type: 'interval', every: '30m' },
	})
	const updateResponse = await handler.handler({
		request: new Request('https://example.com/account/jobs.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'update',
				id: adHocJob.id,
				name: 'Renamed',
				timezone: 'America/Denver',
				schedule: { type: 'interval', every: '30m' },
			}),
		}),
	})
	expect(updateResponse.status).toBe(200)
	expect(mockModule.updateJob).toHaveBeenCalledWith(
		expect.objectContaining({
			body: {
				id: adHocJob.id,
				name: 'Renamed',
				timezone: 'America/Denver',
				schedule: { type: 'interval', every: '30m' },
			},
		}),
	)

	resetInspection()
	const runNowResponse = await handler.handler({
		request: new Request('https://example.com/account/jobs.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'run_now', id: adHocJob.id }),
		}),
	})
	expect(runNowResponse.status).toBe(200)
	expect(mockModule.runJobNowViaManager).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			jobId: adHocJob.id,
		}),
	)
	await expect(runNowResponse.json()).resolves.toMatchObject({
		ok: true,
		runNow: { ok: true, deletedAfterRun: false },
	})

	resetInspection([])
	const deleteResponse = await handler.handler({
		request: new Request('https://example.com/account/jobs.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'delete', id: adHocJob.id }),
		}),
	})
	expect(deleteResponse.status).toBe(200)
	expect(mockModule.deleteJob).toHaveBeenCalledWith({
		env,
		userId: 'stable-user-1',
		jobId: adHocJob.id,
	})
})

test('jobs API rejects unauthenticated and invalid requests', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null)
	const handler = createAccountJobsApiHandler(createEnv())

	const unauthorized = await handler.handler({
		request: new Request('https://example.com/account/jobs.json'),
	})
	expect(unauthorized.status).toBe(401)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce({
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		displayName: 'user',
		artifactOwnerIds: [],
		mcpUser: {
			userId: 'stable-user-1',
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
	})
	const methodNotAllowed = await handler.handler({
		request: new Request('https://example.com/account/jobs.json', {
			method: 'PUT',
		}),
	})
	expect(methodNotAllowed.status).toBe(405)

	const invalidAction = await handler.handler({
		request: new Request('https://example.com/account/jobs.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'nope' }),
		}),
	})
	expect(invalidAction.status).toBe(400)
	await expect(invalidAction.json()).resolves.toEqual({
		ok: false,
		error: 'Invalid action.',
	})
})
