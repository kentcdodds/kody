import { expect, test, vi, afterEach } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildPublishedSourceSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	deleteJob,
	getJob,
	getJobInspection,
	inspectJobsForUser,
	runJobNow,
	syncPackageJobsForPackage,
	updateJob,
} from './service.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { packageOwnedJobDeleteErrorMessage } from './job-retention.ts'
import { buildPackageJobId } from './package-job-id.ts'
import { type PersistedJobCallerContext } from './types.ts'
import {
	repoMockModule,
	jobManagerMockModule,
	resetJobServiceMocks,
	mockRepoPersistence,
	createDatabase,
	createJobServiceTestEnv,
	createBundleArtifactsKv,
	insertPublishedEntitySource,
	createBaseCallerContext,
	insertLeftoverJob,
} from '#worker/test-support/jobs-service.ts'

vi.mock('#worker/repo/source-service.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).sourceServiceMock(),
)
vi.mock('#worker/repo/source-sync.ts', async () =>
	(await import('#worker/test-support/jobs-service-mocks.ts')).sourceSyncMock(),
)
vi.mock('#worker/repo/artifact-repo-cleanup.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).artifactRepoCleanupMock(),
)
vi.mock('#worker/repo/repo-sessions.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).repoSessionsMock(),
)
vi.mock('#worker/repo/repo-session-do.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).repoSessionDoMock(),
)
vi.mock('./manager-client.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).managerClientMock(),
)
vi.mock('#worker/identity/background-mcp-user.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).backgroundMcpUserMock(),
)
vi.mock('#worker/storage-runner.ts', async (importOriginal) =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).storageRunnerMock((await importOriginal()) as Record<string, unknown>),
)
vi.mock('#worker/worker-bundler-modules.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).workerBundlerModulesMock(),
)

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- this legacy suite restores global spies across many integration-style tests.
afterEach(() => {
	resetJobServiceMocks()
})

test('updateJob and deleteJob sync the job manager alarm', async () => {
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase(),
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
	})
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()

	const intervalJob = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Deploy Worker',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})

	expect(intervalJob.schedule).toEqual({
		type: 'interval',
		every: '15m',
	})
	expect(intervalJob.storageId).toBe(`job:${intervalJob.id}`)

	const onceJob = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Leftover once fixture',
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
		},
	})
	expect(onceJob.storageId).toBe(`job:${onceJob.id}`)

	const leftover = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Sync job manager on update',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})

	jobManagerMockModule.syncJobManagerAlarm.mockClear()
	await updateJob({
		env,
		callerContext,
		body: {
			id: leftover.id,
			schedule: {
				type: 'interval',
				every: '30m',
			},
		},
	})

	expect(jobManagerMockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: callerContext.user.userId,
	})
	jobManagerMockModule.syncJobManagerAlarm.mockClear()
	repoMockModule.listRepoSessionsBySource.mockResolvedValueOnce([
		{ id: 'session-1' },
	])
	repoMockModule.cleanupArtifactReposForSource.mockResolvedValueOnce({
		deleted: 1,
		artifactAccessUnavailable: false,
	})

	await deleteJob({
		env,
		userId: callerContext.user.userId,
		jobId: leftover.id,
	})

	expect(repoMockModule.cleanupArtifactReposForSource).toHaveBeenCalledWith({
		env,
		userId: callerContext.user.userId,
		sourceId: leftover.sourceId,
	})
	expect(repoMockModule.deleteRepoSessionsBySourceForUser).toHaveBeenCalledWith(
		env,
		{
			userId: callerContext.user.userId,
			sourceId: leftover.sourceId,
		},
	)
	expect(repoMockModule.cleanupSessionBranch).not.toHaveBeenCalled()
	expect(jobManagerMockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: callerContext.user.userId,
	})
})

test('updateJob and deleteJob reject another user trying to mutate or remove a job by id', async () => {
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase(),
	})
	mockRepoPersistence()
	const ownerCallerContext = createBaseCallerContext()
	const created = await insertLeftoverJob({
		env,
		callerContext: ownerCallerContext,
		body: {
			name: 'Owner job',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})
	const otherCallerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-999',
			email: 'other@example.com',
			displayName: 'Other User',
		},
		storageContext: {
			sessionId: null,
			appId: 'app-999',
		},
	}) as PersistedJobCallerContext

	const updateError = await updateJob({
		env,
		callerContext: otherCallerContext,
		body: {
			id: created.id,
			enabled: false,
		},
	}).catch((caught: unknown) => caught)
	expect(updateError).toBeInstanceOf(McpCallerError)
	expect(updateError).toMatchObject({
		message: `Job "${created.id}" was not found.`,
	})

	let inspection = await getJobInspection({
		env,
		userId: ownerCallerContext.user.userId,
		jobId: created.id,
	})
	expect(inspection.job.enabled).toBe(true)

	const deleteError = await deleteJob({
		env,
		userId: 'user-999',
		jobId: created.id,
	}).catch((caught: unknown) => caught)
	expect(deleteError).toBeInstanceOf(McpCallerError)
	expect(deleteError).toMatchObject({
		message: `Job "${created.id}" was not found.`,
	})

	inspection = await getJobInspection({
		env,
		userId: ownerCallerContext.user.userId,
		jobId: created.id,
	})
	expect(inspection.job.id).toBe(created.id)
})

test('missing job ids throw McpCallerError from get/inspect/run-now', async () => {
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase(),
	})
	const missingJobId = 'missing-job-id'
	const userId = createBaseCallerContext().user.userId

	const getError = await getJob({
		env,
		userId,
		jobId: missingJobId,
	}).catch((caught: unknown) => caught)
	expect(getError).toBeInstanceOf(McpCallerError)
	expect(getError).toMatchObject({
		message: `Job "${missingJobId}" was not found.`,
	})

	const inspectionError = await getJobInspection({
		env,
		userId,
		jobId: missingJobId,
	}).catch((caught: unknown) => caught)
	expect(inspectionError).toBeInstanceOf(McpCallerError)
	expect(inspectionError).toMatchObject({
		message: `Job "${missingJobId}" was not found.`,
	})

	const runNowError = await runJobNow({
		env,
		userId,
		jobId: missingJobId,
	}).catch((caught: unknown) => caught)
	expect(runNowError).toBeInstanceOf(McpCallerError)
	expect(runNowError).toMatchObject({
		message: `Job "${missingJobId}" was not found.`,
	})
})

test('updateJob clears params, updates timezone, and disables a job', async () => {
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase(),
	})
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const created = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Mutable job',
			code: 'export default async () => ({ ok: true })',
			params: {
				room: 'office',
			},
			schedule: {
				type: 'cron',
				expression: '0 9 * * 1',
			},
			timezone: 'UTC',
		},
	})

	const updated = await updateJob({
		env,
		callerContext,
		body: {
			id: created.id,
			params: null,
			timezone: 'America/Denver',
			enabled: false,
		},
	})

	expect(updated.params).toBeUndefined()
	expect(updated.timezone).toBe('America/Denver')
	expect(updated.enabled).toBe(false)

	const emptyCodeError = await updateJob({
		env,
		callerContext,
		body: {
			id: created.id,
			code: '   ',
		},
	}).catch((caught: unknown) => caught)
	expect(emptyCodeError).toBeInstanceOf(McpCallerError)
	expect(emptyCodeError).toMatchObject({
		message: 'Job code cannot be changed via jobUpdate.',
	})
})

test('updateJob updates package-owned job metadata without force-publishing the package source', async () => {
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase(),
	})
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const userId = callerContext.user.userId
	const packageId = 'pkg-1'
	const sourceId = 'package-source-1'
	await insertPublishedEntitySource({
		db: env.APP_DB as ReturnType<typeof createDatabase>,
		userId,
		sourceId,
		entityKind: 'package',
		entityId: packageId,
		publishedCommit: 'package-published-commit',
		manifestPath: 'package.json',
	})
	await syncPackageJobsForPackage({
		env,
		userId,
		baseUrl: callerContext.baseUrl,
		packageId,
		sourceId,
		manifest: parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@owner/personal-history',
				exports: { '.': './index.ts' },
				kody: {
					id: 'personal-history',
					description: 'Personal history',
					jobs: {
						'daily-prompt': {
							entry: './src/jobs/daily-prompt.ts',
							schedule: { type: 'cron', expression: '0 7 * * *' },
							enabled: false,
						},
					},
				},
			}),
		}),
	})
	const jobId = buildPackageJobId(packageId, 'daily-prompt')
	repoMockModule.syncArtifactSourceSnapshot.mockClear()

	const updated = await updateJob({
		env,
		callerContext,
		body: {
			id: jobId,
			enabled: true,
			schedule: {
				type: 'cron',
				expression: '0 8 * * *',
			},
			params: {
				date: '2026-08-18',
			},
		},
	})

	expect(updated.enabled).toBe(true)
	expect(updated.schedule).toEqual({
		type: 'cron',
		expression: '0 8 * * *',
	})
	expect(updated.params).toEqual({
		date: '2026-08-18',
	})
	expect(updated.sourceId).toBe(sourceId)
	expect(updated.publishedCommit).toBe('package-published-commit')
	expect(repoMockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	const identityErrorMessage =
		'Package-owned jobs cannot change name or published source via jobUpdate. Change the job entry in the package repo and publish the package.'
	const codeErrorMessage = 'Job code cannot be changed via jobUpdate.'
	const codeError = await updateJob({
		env,
		callerContext,
		body: {
			id: jobId,
			code: 'export default async () => ({ ok: true })',
		},
	}).catch((caught: unknown) => caught)
	expect(codeError).toBeInstanceOf(McpCallerError)
	expect(codeError).toMatchObject({
		message: codeErrorMessage,
	})
	const nameError = await updateJob({
		env,
		callerContext,
		body: {
			id: jobId,
			name: 'renamed-daily-prompt',
		},
	}).catch((caught: unknown) => caught)
	expect(nameError).toBeInstanceOf(McpCallerError)
	expect(nameError).toMatchObject({
		message: identityErrorMessage,
	})
	const publishedCommitError = await updateJob({
		env,
		callerContext,
		body: {
			id: jobId,
			publishedCommit: 'attacker-chosen-commit',
		},
	}).catch((caught: unknown) => caught)
	expect(publishedCommitError).toBeInstanceOf(McpCallerError)
	expect(publishedCommitError).toMatchObject({
		message: identityErrorMessage,
	})
	expect(repoMockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	const leftover = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Leftover job fixture',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})
	repoMockModule.syncArtifactSourceSnapshot.mockClear()
	await updateJob({
		env,
		callerContext,
		body: {
			id: leftover.id,
			schedule: {
				type: 'interval',
				every: '30m',
			},
		},
	})
	expect(repoMockModule.syncArtifactSourceSnapshot).toHaveBeenCalled()

	const leftoverCodeError = await updateJob({
		env,
		callerContext,
		body: {
			id: leftover.id,
			code: 'export default async () => ({ ok: true, rewritten: true })',
		},
	}).catch((caught: unknown) => caught)
	expect(leftoverCodeError).toBeInstanceOf(McpCallerError)
	expect(leftoverCodeError).toMatchObject({
		message: codeErrorMessage,
	})

	const packageDeleteError = await deleteJob({
		env,
		userId,
		jobId,
	}).catch((caught: unknown) => caught)
	expect(packageDeleteError).toBeInstanceOf(McpCallerError)
	expect(packageDeleteError).toMatchObject({
		message: packageOwnedJobDeleteErrorMessage,
	})
	expect(
		await getJobInspection({
			env,
			userId,
			jobId,
		}),
	).toMatchObject({
		job: { id: jobId },
	})
})

test('updateJob rejects code changes on leftover jobs', async () => {
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase(),
	})
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const leftover = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Mutable leftover job',
			schedule: {
				type: 'once',
				runAt: new Date(Date.now() + 60_000).toISOString(),
			},
		},
	})

	const updateError = await updateJob({
		env,
		callerContext,
		body: {
			id: leftover.id,
			code: 'async () => ({ ok: true })',
		},
	}).catch((caught: unknown) => caught)

	expect(updateError).toBeInstanceOf(McpCallerError)
	expect(updateError).toMatchObject({
		message: 'Job code cannot be changed via jobUpdate.',
	})
})

test('inspectJobsForUser returns persisted job fields with alarm debug state', async () => {
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase(),
	})
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const created = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Inspect recurring job',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})
	const jobRow = await (
		await import('@kody-internal/shared/jobs/repo.ts')
	).getJobRowById(env.APP_DB, callerContext.user.userId, created.id)
	if (!jobRow) {
		throw new Error('Expected created job row.')
	}
	jobRow.record.lastRunAt = '2026-04-20T10:05:00.000Z'
	jobRow.record.lastRunStatus = 'error'
	jobRow.record.nextRunAt = '2026-04-20T10:00:00.000Z'
	jobRow.record.updatedAt = '2026-04-20T10:05:00.000Z'
	await (
		await import('@kody-internal/shared/jobs/repo.ts')
	).updateJobRow({
		db: env.APP_DB,
		userId: callerContext.user.userId,
		job: jobRow.record,
		callerContextJson: jobRow.callerContextJson,
	})
	jobManagerMockModule.getJobManagerDebugState.mockResolvedValue({
		bindingAvailable: true,
		status: 'armed',
		storedUserId: callerContext.user.userId,
		alarmScheduledFor: '2026-04-20T10:00:00.000Z',
		nextRunnableJobId: created.id,
		nextRunnableRunAt: '2026-04-20T10:00:00.000Z',
		alarmInSync: true,
	})
	const observabilitySpy = vi
		.spyOn(
			await import('#worker/run-records/service.ts'),
			'getJobRunObservabilityBatch',
		)
		.mockResolvedValue([
			{
				jobId: created.id,
				lastRunAt: '2026-04-20T10:05:00.000Z',
				lastRunStatus: 'error',
				lastRunError: 'Worker fetch failed',
				lastDurationMs: 321,
				runCount: 3,
				successCount: 1,
				errorCount: 2,
				updatedAt: '2026-04-20T10:05:00.000Z',
			},
		])

	try {
		const inspected = await inspectJobsForUser({
			env,
			userId: callerContext.user.userId,
			now: new Date('2026-04-20T10:10:00.000Z'),
		})

		expect(jobManagerMockModule.getJobManagerDebugState).toHaveBeenCalledWith({
			env,
			userId: callerContext.user.userId,
		})
		expect(observabilitySpy).toHaveBeenCalledWith({
			env,
			userId: callerContext.user.userId,
			jobIds: [created.id],
		})
		expect(inspected.alarm).toEqual({
			bindingAvailable: true,
			status: 'armed',
			storedUserId: 'user-123',
			alarmScheduledFor: '2026-04-20T10:00:00.000Z',
			nextRunnableJobId: created.id,
			nextRunnableRunAt: '2026-04-20T10:00:00.000Z',
			alarmInSync: true,
		})
		expect(inspected.jobs).toEqual([
			expect.objectContaining({
				id: created.id,
				name: 'Inspect recurring job',
				sourceId: created.sourceId,
				storageId: created.storageId,
				lastRunAt: '2026-04-20T10:05:00.000Z',
				lastRunStatus: 'error',
				lastRunError: 'Worker fetch failed',
				lastDurationMs: 321,
				runCount: 3,
				successCount: 1,
				errorCount: 2,
			}),
		])
	} finally {
		observabilitySpy.mockRestore()
	}
})

test('getJobInspection reports alarm state, source code, and artifact gaps', async () => {
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase(),
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
	})
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const created = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Inspect one job',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'once',
				runAt: '2026-04-20T18:30:00Z',
			},
		},
	})
	jobManagerMockModule.getJobManagerDebugState.mockResolvedValue({
		bindingAvailable: true,
		status: 'out_of_sync',
		storedUserId: callerContext.user.userId,
		alarmScheduledFor: '2026-04-20T18:35:00.000Z',
		nextRunnableJobId: created.id,
		nextRunnableRunAt: '2026-04-20T18:30:00.000Z',
		alarmInSync: false,
	})

	const inspected = await getJobInspection({
		env,
		userId: callerContext.user.userId,
		jobId: created.id,
		now: new Date('2026-04-20T18:00:00.000Z'),
	})

	expect(inspected.job).toMatchObject({
		id: created.id,
		name: 'Inspect one job',
		sourceId: created.sourceId,
		storageId: created.storageId,
		lastRunAt: undefined,
		lastRunStatus: undefined,
		lastRunError: undefined,
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	})
	expect(inspected.alarm).toEqual({
		bindingAvailable: true,
		status: 'out_of_sync',
		storedUserId: 'user-123',
		alarmScheduledFor: '2026-04-20T18:35:00.000Z',
		nextRunnableJobId: created.id,
		nextRunnableRunAt: '2026-04-20T18:30:00.000Z',
		alarmInSync: false,
	})
	expect(inspected).not.toHaveProperty('source')

	const code =
		'export default async function main() { return { custom: true } }'
	await insertPublishedEntitySource({
		db: env.APP_DB as ReturnType<typeof createDatabase>,
		env,
		userId: callerContext.user.userId,
		sourceId: created.sourceId,
		entityId: created.id,
		publishedCommit: 'published-commit-2',
		files: {
			'kody.json': JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Inspect source job',
				description: 'Job source fixture',
				entrypoint: 'src/custom-job.ts',
			}),
			'src/custom-job.ts': code,
		},
	})

	const inspectedWithSource = await getJobInspection({
		env,
		userId: callerContext.user.userId,
		jobId: created.id,
		includeCode: true,
	})

	expect(inspectedWithSource.source).toEqual({
		entrypoint: 'src/custom-job.ts',
		code,
		error: null,
	})

	const missingEntrypointJob = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Missing source job',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})
	await insertPublishedEntitySource({
		db: env.APP_DB as ReturnType<typeof createDatabase>,
		env,
		userId: callerContext.user.userId,
		sourceId: missingEntrypointJob.sourceId,
		entityId: missingEntrypointJob.id,
		publishedCommit: 'published-commit-2',
		files: {
			'kody.json': JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Missing source job',
				description: 'Missing entrypoint fixture',
				entrypoint: 'src/missing-job.ts',
			}),
		},
	})

	const missingEntrypointInspection = await getJobInspection({
		env,
		userId: callerContext.user.userId,
		jobId: missingEntrypointJob.id,
		includeCode: true,
	})

	expect(missingEntrypointInspection.job.id).toBe(missingEntrypointJob.id)
	expect(missingEntrypointInspection.source).toEqual({
		entrypoint: 'src/missing-job.ts',
		code: null,
		error: 'Job entrypoint "src/missing-job.ts" was not found.',
	})

	const bundleKv = createBundleArtifactsKv()
	const manifestEnv = createJobServiceTestEnv({
		APP_DB: createDatabase(),
		BUNDLE_ARTIFACTS_KV: bundleKv,
	})
	const missingManifestJob = await insertLeftoverJob({
		env: manifestEnv,
		callerContext,
		body: {
			name: 'Missing manifest job',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})
	await insertPublishedEntitySource({
		db: manifestEnv.APP_DB as ReturnType<typeof createDatabase>,
		env: manifestEnv,
		userId: callerContext.user.userId,
		sourceId: missingManifestJob.sourceId,
		entityId: missingManifestJob.id,
		publishedCommit: 'published-commit-2',
	})
	await bundleKv.put(
		buildPublishedSourceSnapshotKvKey({
			sourceId: missingManifestJob.sourceId,
			publishedCommit: 'published-commit-2',
		}),
		JSON.stringify({
			version: 1,
			sourceId: missingManifestJob.sourceId,
			repoId: `job-${missingManifestJob.id}`,
			entityKind: 'job',
			entityId: missingManifestJob.id,
			publishedCommit: 'published-commit-2',
			manifestPath: 'kody.json',
			sourceRoot: '/',
			files: {
				'src/job.ts': 'export default async () => ({ ok: true })',
			},
			createdAt: '2026-04-16T00:00:00.000Z',
		}),
	)

	const missingManifestInspection = await getJobInspection({
		env: manifestEnv,
		userId: callerContext.user.userId,
		jobId: missingManifestJob.id,
		includeCode: true,
	})

	expect(missingManifestInspection.job.id).toBe(missingManifestJob.id)
	expect(missingManifestInspection.source).toEqual({
		entrypoint: null,
		code: null,
		error: 'Job manifest "kody.json" was not found.',
	})
})
