import { RequestContext } from 'remix/router'
import { expect, test, vi } from 'vitest'
import type * as authenticatedUserModule from '#app/authenticated-user.ts'
import type * as appBaseUrl from '#worker/app-base-url.ts'
import type * as jobRetention from '#worker/jobs/job-retention-cleanup.ts'
import type * as packageRepo from '#worker/package-registry/repo.ts'

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
	preserved: false,
	expiresAt: null,
	expired: false,
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
	readAuthenticatedAppUser: vi.fn<
		typeof authenticatedUserModule.readAuthenticatedAppUser
	>(async () => ({
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'user',
		roles: ['user'],
		permissions: [],
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
	getAppBaseUrl: vi.fn<typeof appBaseUrl.getAppBaseUrl>(
		() => 'https://example.com',
	),
	listRunRecords: vi.fn(),
	readJobRetentionPreferencesForUser: vi.fn<
		typeof jobRetention.readJobRetentionPreferencesForUser
	>(async () => ({
		successOnceDays: 14,
		failedOrNeverRanOnceDays: 60,
		disabledRecurringDays: 90,
	})),
	updateJobRetentionPreferencesForUser: vi.fn<
		typeof jobRetention.updateJobRetentionPreferencesForUser
	>(async (input) => ({
		successOnceDays: input.successOnceDays,
		failedOrNeverRanOnceDays: input.failedOrNeverRanOnceDays,
		disabledRecurringDays: input.disabledRecurringDays,
	})),
	listSavedPackagesByUserId: vi.fn<
		typeof packageRepo.listSavedPackagesByUserId
	>(async () => [
		{
			id: 'pkg-1',
			userId: 'stable-user-1',
			name: 'State Store',
			kodyId: 'state-store',
			description: '',
			tags: [],
			searchText: null,
			sourceId: 'source-pkg-1',
			hasApp: false,
			hasSkills: false,
			hidden: false,
			isPrivate: true,
			lockedAt: null,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	]),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof authenticatedUserModule.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
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

vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: (...args: Parameters<typeof appBaseUrl.getAppBaseUrl>) =>
		mockModule.getAppBaseUrl(...args),
}))

vi.mock('#worker/jobs/inspect.ts', () => ({
	inspectJobsForUser: (...args: Array<unknown>) =>
		mockModule.inspectJobsForUser(...args),
}))

vi.mock('#worker/jobs/service.ts', () => ({
	updateJob: (...args: Array<unknown>) => mockModule.updateJob(...args),
	deleteJob: (...args: Array<unknown>) => mockModule.deleteJob(...args),
}))

vi.mock('#worker/jobs/manager-client.ts', () => ({
	runJobNowViaManager: (...args: Array<unknown>) =>
		mockModule.runJobNowViaManager(...args),
}))

vi.mock('#worker/jobs/job-retention-cleanup.ts', () => ({
	readJobRetentionPreferencesForUser: (
		...args: Parameters<typeof jobRetention.readJobRetentionPreferencesForUser>
	) => mockModule.readJobRetentionPreferencesForUser(...args),
	updateJobRetentionPreferencesForUser: (
		...args: Parameters<
			typeof jobRetention.updateJobRetentionPreferencesForUser
		>
	) => mockModule.updateJobRetentionPreferencesForUser(...args),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: (...args: Array<unknown>) =>
		mockModule.listRunRecords(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (
		...args: Parameters<typeof packageRepo.listSavedPackagesByUserId>
	) => mockModule.listSavedPackagesByUserId(...args),
}))

const { createAccountJobsApiHandler } = await import('./account-jobs.ts')

const jobsUrl = 'https://example.com/account/jobs.json'

function stubInspection(jobs: Array<typeof adHocJob | typeof packageJob>) {
	mockModule.inspectJobsForUser.mockResolvedValue({ jobs, alarm: alarmState })
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
					errorName: 'error' in entry ? 'Error' : null,
					errorMessage: 'error' in entry ? entry.error : null,
					metadata: {},
					logCount: 0,
				})),
				nextCursor: null,
			}
		},
	)
}

function createJobsClient() {
	stubInspection([adHocJob, packageJob])
	const env = { APP_DB: {} as D1Database, COOKIE_SECRET: 'secret' } as Env
	const { handler } = createAccountJobsApiHandler(env)
	return {
		env,
		get: (search = '') =>
			handler(new RequestContext(new Request(jobsUrl + search))),
		post: (body: Record<string, unknown>) =>
			handler(
				new RequestContext(
					new Request(jobsUrl, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(body),
					}),
				),
			),
		put: () =>
			handler(new RequestContext(new Request(jobsUrl, { method: 'PUT' }))),
	}
}

test('jobs API lists jobs with ownership and selected detail', async () => {
	const { get } = createJobsClient()

	const listResponse = await get()
	expect(listResponse.status).toBe(200)
	expect(listResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(mockModule.inspectJobsForUser).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: 'stable-user-1',
	})
	await expect(listResponse.json()).resolves.toMatchObject({
		ok: true,
		username: 'test-user',
		selectedJobId: null,
		selectedJob: null,
		retention: {
			successOnceDays: 14,
			failedOrNeverRanOnceDays: 60,
			disabledRecurringDays: 90,
			defaults: {
				successOnce: 14,
				failedOrNeverRanOnce: 60,
				disabledRecurring: 90,
			},
		},
		jobs: [
			expect.objectContaining({
				id: 'job-adhoc-1',
				ownership: 'ad-hoc',
				packageId: null,
				packageName: null,
				packageKodyId: null,
				scheduleSummary: adHocJob.scheduleSummary,
				scheduleType: 'cron',
				enabled: true,
				killSwitchEnabled: false,
				preserved: false,
				expiresAt: null,
				expired: false,
			}),
			expect.objectContaining({
				id: 'package-job:pkg-1:nightly',
				ownership: 'package',
				packageId: 'pkg-1',
				packageName: 'State Store',
				packageKodyId: 'state-store',
				scheduleType: 'interval',
			}),
		],
		alarm: expect.objectContaining({
			bindingAvailable: true,
			status: 'armed',
		}),
	})

	const detailResponse = await get('?selected=job-adhoc-1')
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

test('jobs API rejects unauthenticated, invalid, and package-owned mutations', async () => {
	const { get, post, put } = createJobsClient()
	mockModule.updateJob.mockResolvedValue(packageJob)
	mockModule.deleteJob.mockResolvedValue({ id: packageJob.id, deleted: true })

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null as never)
	expect((await get()).status).toBe(401)
	expect((await put()).status).toBe(405)

	const invalidAction = await post({ action: 'nope' })
	expect(invalidAction.status).toBe(400)
	await expect(invalidAction.json()).resolves.toEqual({
		ok: false,
		error: 'Invalid action.',
	})

	for (const body of [
		{ action: 'set_enabled', id: packageJob.id, enabled: false },
		{ action: 'set_preserved', id: packageJob.id, preserved: true },
		{ action: 'delete', id: packageJob.id },
	]) {
		const response = await post(body)
		expect([body.action, response.status]).toEqual([body.action, 400])
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining('Package-owned jobs cannot'),
		})
	}
	expect(mockModule.updateJob).not.toHaveBeenCalled()
	expect(mockModule.deleteJob).not.toHaveBeenCalled()
})

test('jobs API mutations are user-scoped for non-package jobs and kill switch', async () => {
	const { env, post } = createJobsClient()
	mockModule.deleteJob.mockResolvedValue({ id: adHocJob.id, deleted: true })
	mockModule.runJobNowViaManager.mockResolvedValue({
		job: adHocJob,
		execution: { ok: true, logs: [] },
		deletedAfterRun: false,
	})

	mockModule.updateJob.mockResolvedValue({ ...adHocJob, enabled: false })
	const disableResponse = await post({
		action: 'set_enabled',
		id: adHocJob.id,
		enabled: false,
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

	mockModule.updateJob.mockResolvedValue({
		...packageJob,
		killSwitchEnabled: true,
	})
	const killSwitchResponse = await post({
		action: 'set_kill_switch',
		id: packageJob.id,
		killSwitchEnabled: true,
		preserved: false,
		expiresAt: null,
		expired: false,
	})
	expect(killSwitchResponse.status).toBe(200)
	expect(mockModule.updateJob).toHaveBeenLastCalledWith(
		expect.objectContaining({
			body: { id: packageJob.id, killSwitchEnabled: true },
		}),
	)

	mockModule.updateJob.mockResolvedValue({ ...adHocJob, preserved: true })
	const preserveResponse = await post({
		action: 'set_preserved',
		id: adHocJob.id,
		preserved: true,
	})
	expect(preserveResponse.status).toBe(200)
	expect(mockModule.updateJob).toHaveBeenLastCalledWith(
		expect.objectContaining({ body: { id: adHocJob.id, preserved: true } }),
	)

	const runNowResponse = await post({ action: 'run_now', id: adHocJob.id })
	expect(runNowResponse.status).toBe(200)
	expect(mockModule.runJobNowViaManager).toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'stable-user-1', jobId: adHocJob.id }),
	)
	await expect(runNowResponse.json()).resolves.toMatchObject({
		ok: true,
		runNow: { ok: true, deletedAfterRun: false },
	})

	stubInspection([])
	const deleteResponse = await post({ action: 'delete', id: adHocJob.id })
	expect(deleteResponse.status).toBe(200)
	expect(mockModule.deleteJob).toHaveBeenCalledWith({
		env,
		userId: 'stable-user-1',
		jobId: adHocJob.id,
	})
})
