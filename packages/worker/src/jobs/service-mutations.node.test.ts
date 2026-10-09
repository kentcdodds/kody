import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi, afterEach } from 'vitest'
import { getJobRowById, updateJobRow } from '@kody-internal/shared/jobs/repo.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildPublishedSourceSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import * as runRecords from '#worker/run-records/service.ts'
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
import { type JobRecord, type PersistedJobCallerContext } from './types.ts'
import { type RepoSessionRow } from '#worker/repo/types.ts'
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
	withCallerUser,
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

const every15m = { type: 'interval', every: '15m' } as const
const codeErrorMessage = 'Job code cannot be changed via jobUpdate.'

function setup(bindings: Partial<Env> = {}) {
	const env = createJobServiceTestEnv({ APP_DB: createDatabase(), ...bindings })
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	return { env, callerContext, userId: callerContext.user.userId }
}

function insertJob(
	env: Env,
	callerContext: PersistedJobCallerContext,
	name: string,
	schedule: JobRecord['schedule'] = every15m,
) {
	return insertLeftoverJob({
		env,
		callerContext,
		body: {
			name,
			code: 'export default async () => ({ ok: true })',
			schedule,
		},
	})
}

async function expectCallerError(promise: Promise<unknown>, message: string) {
	const error = await promise.catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(McpCallerError)
	expect(error).toMatchObject({ message })
}

function createRepoSessionRow(input: {
	id: string
	userId: string
	sourceId: string
}): RepoSessionRow {
	return {
		id: input.id,
		user_id: input.userId,
		source_id: input.sourceId,
		source_repo_id: 'source-repo-1',
		session_branch: `sessions/${input.id}`,
		source_branch: 'main',
		base_commit: 'published-commit-1',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: '2026-04-16T00:00:00.000Z',
		updated_at: '2026-04-16T00:00:00.000Z',
	}
}

test('updateJob and deleteJob sync the job manager alarm', async () => {
	const { env, callerContext, userId } = setup({
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
	})
	for (const schedule of [
		every15m,
		{ type: 'once', runAt: '2026-04-17T15:00:00Z' } as const,
	]) {
		const job = await insertJob(env, callerContext, 'Fixture', schedule)
		expect(job.schedule).toEqual(schedule)
		expect(job.storageId).toBe(`job:${job.id}`)
	}
	const leftover = await insertJob(env, callerContext, 'Sync on update')

	jobManagerMockModule.syncJobManagerAlarm.mockClear()
	await updateJob({
		env,
		callerContext,
		body: { id: leftover.id, schedule: { type: 'interval', every: '30m' } },
	})
	expect(jobManagerMockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId,
	})

	jobManagerMockModule.syncJobManagerAlarm.mockClear()
	repoMockModule.listRepoSessionsBySource.mockResolvedValueOnce([
		createRepoSessionRow({
			id: 'session-1',
			userId,
			sourceId: leftover.sourceId,
		}),
	])
	repoMockModule.cleanupArtifactReposForSource.mockResolvedValueOnce({
		deleted: 1,
		artifactAccessUnavailable: false,
	})
	await deleteJob({ env, userId, jobId: leftover.id })

	expect(repoMockModule.cleanupArtifactReposForSource).toHaveBeenCalledWith({
		env,
		userId,
		sourceId: leftover.sourceId,
	})
	expect(repoMockModule.deleteRepoSessionsBySourceForUser).toHaveBeenCalledWith(
		env,
		{ userId, sourceId: leftover.sourceId },
	)
	expect(repoMockModule.cleanupSessionBranch).not.toHaveBeenCalled()
	expect(jobManagerMockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId,
	})
})

test('updateJob and deleteJob reject another user trying to mutate or remove a job by id', async () => {
	const { env, callerContext, userId } = setup()
	const created = await insertJob(env, callerContext, 'Owner job')
	const otherCallerContext = withCallerUser(
		createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('user-999'),
				email: 'other@example.com',
				displayName: 'Other User',
			},
			storageContext: {
				sessionId: null,
				appId: 'app-999',
				packageId: null,
				storageId: null,
			},
		}),
	)
	const notFound = `Job "${created.id}" was not found.`

	await expectCallerError(
		updateJob({
			env,
			callerContext: otherCallerContext,
			body: { id: created.id, enabled: false },
		}),
		notFound,
	)
	await expectCallerError(
		deleteJob({ env, userId: 'user-999', jobId: created.id }),
		notFound,
	)
	const inspection = await getJobInspection({ env, userId, jobId: created.id })
	expect(inspection.job).toMatchObject({ id: created.id, enabled: true })
})

test('missing job ids throw McpCallerError from get/inspect/run-now', async () => {
	expect.assertions(6)
	const env = createJobServiceTestEnv({ APP_DB: createDatabase() })
	const input = {
		env,
		userId: createBaseCallerContext().user.userId,
		jobId: 'missing-job-id',
	}
	for (const lookup of [getJob, getJobInspection, runJobNow]) {
		await expectCallerError(
			lookup(input),
			'Job "missing-job-id" was not found.',
		)
	}
})

test('updateJob clears params, updates timezone, and disables a job', async () => {
	const { env, callerContext } = setup()
	const created = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Mutable job',
			code: 'export default async () => ({ ok: true })',
			params: { room: 'office' },
			schedule: { type: 'cron', expression: '0 9 * * 1' },
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
	await expectCallerError(
		updateJob({ env, callerContext, body: { id: created.id, code: '   ' } }),
		codeErrorMessage,
	)
})

test('updateJob updates package-owned job metadata without force-publishing the package source', async () => {
	const { env, callerContext, userId } = setup()
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
			schedule: { type: 'cron', expression: '0 8 * * *' },
			params: { date: '2026-08-18' },
		},
	})

	expect(updated).toMatchObject({
		enabled: true,
		sourceId,
		publishedCommit: 'package-published-commit',
	})
	expect(updated.schedule).toEqual({ type: 'cron', expression: '0 8 * * *' })
	expect(updated.params).toEqual({ date: '2026-08-18' })
	const identityErrorMessage =
		'Package-owned jobs cannot change name or published source via jobUpdate. Change the job entry in the package repo and publish the package.'
	for (const [body, message] of [
		[{ code: 'export default async () => ({ ok: true })' }, codeErrorMessage],
		[{ name: 'renamed-daily-prompt' }, identityErrorMessage],
		[{ publishedCommit: 'attacker-chosen-commit' }, identityErrorMessage],
	] as const) {
		await expectCallerError(
			updateJob({ env, callerContext, body: { id: jobId, ...body } }),
			message,
		)
	}
	expect(repoMockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	// Leftover jobs still republish their source on metadata edits.
	const leftover = await insertJob(env, callerContext, 'Leftover job fixture')
	repoMockModule.syncArtifactSourceSnapshot.mockClear()
	await updateJob({
		env,
		callerContext,
		body: { id: leftover.id, schedule: { type: 'interval', every: '30m' } },
	})
	expect(repoMockModule.syncArtifactSourceSnapshot).toHaveBeenCalled()
	await expectCallerError(
		updateJob({
			env,
			callerContext,
			body: {
				id: leftover.id,
				code: 'export default async () => ({ ok: true, rewritten: true })',
			},
		}),
		codeErrorMessage,
	)

	await expectCallerError(
		deleteJob({ env, userId, jobId }),
		packageOwnedJobDeleteErrorMessage,
	)
	expect(await getJobInspection({ env, userId, jobId })).toMatchObject({
		job: { id: jobId },
	})
})

test('inspectJobsForUser returns persisted job fields with alarm debug state', async () => {
	const { env, callerContext, userId } = setup()
	const created = await insertJob(env, callerContext, 'Inspect recurring job')
	const jobRow = await getJobRowById(env.APP_DB, userId, created.id)
	if (!jobRow) throw new Error('Expected created job row.')
	Object.assign(jobRow.record, {
		lastRunAt: '2026-04-20T10:05:00.000Z',
		lastRunStatus: 'error',
		nextRunAt: '2026-04-20T10:00:00.000Z',
		updatedAt: '2026-04-20T10:05:00.000Z',
	})
	await updateJobRow({
		db: env.APP_DB,
		userId,
		job: jobRow.record,
		callerContextJson: jobRow.callerContextJson,
	})
	const alarm = {
		bindingAvailable: true,
		status: 'armed',
		storedUserId: userId,
		alarmScheduledFor: '2026-04-20T10:00:00.000Z',
		nextRunnableJobId: created.id,
		nextRunnableRunAt: '2026-04-20T10:00:00.000Z',
		alarmInSync: true,
	} as const
	jobManagerMockModule.getJobManagerDebugState.mockResolvedValue(alarm)
	const observability = {
		lastRunAt: '2026-04-20T10:05:00.000Z',
		lastRunStatus: 'error',
		lastRunError: 'Worker fetch failed',
		lastDurationMs: 321,
		runCount: 3,
		successCount: 1,
		errorCount: 2,
	} as const
	const observabilitySpy = vi
		.spyOn(runRecords, 'getJobRunObservabilityBatch')
		.mockResolvedValue([
			{
				jobId: created.id,
				...observability,
				updatedAt: '2026-04-20T10:05:00.000Z',
			},
		])

	const inspected = await inspectJobsForUser({
		env,
		userId,
	})

	expect(jobManagerMockModule.getJobManagerDebugState).toHaveBeenCalledWith({
		env,
		userId,
	})
	expect(observabilitySpy).toHaveBeenCalledWith({
		env,
		userId,
		jobIds: [created.id],
	})
	expect(inspected.alarm).toEqual({ ...alarm, storedUserId: 'user-123' })
	expect(inspected.jobs).toEqual([
		expect.objectContaining({
			id: created.id,
			name: 'Inspect recurring job',
			sourceId: created.sourceId,
			storageId: created.storageId,
			...observability,
		}),
	])
})

test('getJobInspection reports alarm state, source code, and artifact gaps', async () => {
	const { env, callerContext, userId } = setup({
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
	})
	const created = await insertJob(env, callerContext, 'Inspect one job', {
		type: 'once',
		runAt: '2026-04-20T18:30:00Z',
	})
	const alarm = {
		bindingAvailable: true,
		status: 'out_of_sync',
		storedUserId: userId,
		alarmScheduledFor: '2026-04-20T18:35:00.000Z',
		nextRunnableJobId: created.id,
		nextRunnableRunAt: '2026-04-20T18:30:00.000Z',
		alarmInSync: false,
	} as const
	jobManagerMockModule.getJobManagerDebugState.mockResolvedValue(alarm)

	const inspected = await getJobInspection({
		env,
		userId,
		jobId: created.id,
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
	expect(inspected.alarm).toEqual({ ...alarm, storedUserId: 'user-123' })
	expect(inspected).not.toHaveProperty('source')

	const publishKodyJob = (
		job: { id: string; sourceId: string },
		entrypoint: string,
		files: Record<string, string> = {},
	) =>
		insertPublishedEntitySource({
			db: env.APP_DB as ReturnType<typeof createDatabase>,
			env,
			userId,
			sourceId: job.sourceId,
			entityId: job.id,
			publishedCommit: 'published-commit-2',
			files: {
				'kody.json': JSON.stringify({
					version: 1,
					kind: 'job',
					title: 'Inspect source job',
					description: 'Job source fixture',
					entrypoint,
				}),
				...files,
			},
		})
	const inspectCode = (jobId: string, inspectEnv = env) =>
		getJobInspection({ env: inspectEnv, userId, jobId, includeCode: true })

	const code =
		'export default async function main() { return { custom: true } }'
	await publishKodyJob(created, 'src/custom-job.ts', {
		'src/custom-job.ts': code,
	})
	expect((await inspectCode(created.id)).source).toEqual({
		entrypoint: 'src/custom-job.ts',
		code,
		error: null,
	})

	const missingEntrypointJob = await insertJob(
		env,
		callerContext,
		'Missing source job',
	)
	await publishKodyJob(missingEntrypointJob, 'src/missing-job.ts')
	const missingEntrypoint = await inspectCode(missingEntrypointJob.id)
	expect(missingEntrypoint.job.id).toBe(missingEntrypointJob.id)
	expect(missingEntrypoint.source).toEqual({
		entrypoint: 'src/missing-job.ts',
		code: null,
		error: 'Job entrypoint "src/missing-job.ts" was not found.',
	})

	const bundleKv = createBundleArtifactsKv()
	const manifestEnv = createJobServiceTestEnv({
		APP_DB: createDatabase(),
		BUNDLE_ARTIFACTS_KV: bundleKv,
	})
	const missingManifestJob = await insertJob(
		manifestEnv,
		callerContext,
		'Missing manifest job',
	)
	await insertPublishedEntitySource({
		db: manifestEnv.APP_DB as ReturnType<typeof createDatabase>,
		env: manifestEnv,
		userId,
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
			files: { 'src/job.ts': 'export default async () => ({ ok: true })' },
			createdAt: '2026-04-16T00:00:00.000Z',
		}),
	)
	const missingManifest = await inspectCode(missingManifestJob.id, manifestEnv)
	expect(missingManifest.job.id).toBe(missingManifestJob.id)
	expect(missingManifest.source).toEqual({
		entrypoint: null,
		code: null,
		error: 'Job manifest "kody.json" was not found.',
	})
})
