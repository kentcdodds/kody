import { expect, test, vi, afterEach } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { buildJobSourceFiles } from '#worker/repo/source-templates.ts'
import { executeJobOnce, runJobNow } from './service.ts'
import { type JobRecord } from './types.ts'
import { TransientJobExecutionError } from './execution-safety.ts'
import { createStorageEstimateReadError } from '#worker/storage-estimate-error.ts'
import { durableObjectInstanceInactiveCloseMessage } from '#worker/sentry-options.ts'
import { d1NetworkConnectionLostMessage } from '#worker/d1-retry.ts'
import {
	resetJobServiceMocks,
	mockRepoPersistence,
	createPackageJobManifest,
	createPackageJobManifestText,
	createDatabase,
	createJobServiceTestEnv,
	createStorageRunnerBinding,
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

test('executeJobOnce failure modes workflow', async () => {
	// Phase: stale repo session discard failure
	{
		silenceIncidentalRuntimeWarnings()
		const db = createDatabase()
		const bundleKv = createBundleArtifactsKv()
		await insertPublishedEntitySource({
			db,
			userId: 'user-123',
			sourceId: 'source-1',
			entityKind: 'package',
			entityId: 'job-repo-discard-failure',
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
		})
		const env = createJobServiceTestEnv({
			APP_DB: db,
			CLOUDFLARE_ACCOUNT_ID: 'acct-test',
			CLOUDFLARE_API_TOKEN: 'token-test',
			BUNDLE_ARTIFACTS_KV: bundleKv,
			LOADER: {} as WorkerLoader,
		})
		const callerContext = createBaseCallerContext()
		const job: JobRecord = {
			version: 1,
			id: 'job-repo-discard-failure',
			userId: callerContext.user.userId,
			name: 'Repo-backed job discard failure',
			code: null,
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			storageId: 'job:job-repo-discard-failure',
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
			timezone: 'UTC',
			enabled: true,
			killSwitchEnabled: false,
			preserved: false,
			expiresAt: null,
			createdAt: '2026-04-16T00:00:00.000Z',
			updatedAt: '2026-04-16T00:00:00.000Z',
			nextRunAt: '2026-04-17T15:00:00.000Z',
			runCount: 0,
			successCount: 0,
			errorCount: 0,
		}

		const discardFailure = new Error('D1 delete failed')
		const sessionClient = {
			openSession: vi.fn(async () => ({
				id: 'job-runtime-job-repo-discard-failure',
				source_id: 'source-1',
				source_root: '/',
				base_commit: 'base-1',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'commit-1',
				manifest_path: 'package.json',
				entity_type: 'job' as const,
			})),
			runChecks: vi.fn(),
			readFile: vi.fn(),
			discardSession: vi.fn(async () => {
				throw discardFailure
			}),
		}

		const repoSessionRpcSpy = vi
			.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
			.mockReturnValue(sessionClient as never)
		const formatJobErrorSpy = vi.spyOn(
			await import('./schedule.ts'),
			'formatJobError',
		)
		const executeSpy = vi.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)

		try {
			const outcome = await executeJobOnce({
				env,
				job,
				callerContext,
			})

			expect(outcome.execution).toEqual({
				ok: false,
				error:
					'Published snapshot for source "source-1" at commit "commit-1" was not found.',
				logs: [],
			})
			expect(executeSpy).not.toHaveBeenCalled()
			expect(formatJobErrorSpy).toHaveBeenCalled()
		} finally {
			repoSessionRpcSpy.mockRestore()
			formatJobErrorSpy.mockRestore()
			executeSpy.mockRestore()
		}
	}

	// Phase: kody secret policy rejection
	{
		silenceIncidentalRuntimeWarnings()
		const db = createDatabase()
		const bundleKv = createBundleArtifactsKv()
		await insertPublishedEntitySource({
			db,
			userId: 'user-123',
			sourceId: 'source-secret-policy',
			entityKind: 'package',
			entityId: 'job-1',
			publishedCommit: 'commit-secret-policy',
			manifestPath: 'package.json',
			files: {
				'package.json': createPackageJobManifestText({
					packageName: '@kody/forbidden-secret-access',
					kodyId: 'forbidden-secret-access',
					description: 'Runs from repo',
					jobName: 'Forbidden secret access',
				}),
				'src/job.ts': 'export default async () => ({ ok: true })',
			},
			env: {
				APP_DB: db,
				BUNDLE_ARTIFACTS_KV: bundleKv,
			} as Env,
		})
		const env = createJobServiceTestEnv({
			APP_DB: db,
			CLOUDFLARE_ACCOUNT_ID: 'acct-test',
			CLOUDFLARE_API_TOKEN: 'token-test',
			BUNDLE_ARTIFACTS_KV: bundleKv,
			LOADER: {} as WorkerLoader,
		})
		const callerContext = createBaseCallerContext()
		const job: JobRecord = {
			version: 1,
			id: 'job-1',
			userId: callerContext.user.userId,
			name: 'Forbidden secret access',
			sourceId: 'source-secret-policy',
			publishedCommit: 'commit-secret-policy',
			storageId: 'job:job-1',
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
			timezone: 'UTC',
			enabled: true,
			killSwitchEnabled: false,
			preserved: false,
			expiresAt: null,
			createdAt: '2026-04-16T00:00:00.000Z',
			updatedAt: '2026-04-16T00:00:00.000Z',
			nextRunAt: '2026-04-17T15:00:00.000Z',
			runCount: 0,
			successCount: 0,
			errorCount: 0,
		}

		const executeSpy = vi
			.spyOn(
				await import('#mcp/run-kody-registry.ts'),
				'runBundledModuleWithRegistry',
			)
			.mockResolvedValue({
				error: 'Secret "apiToken" is not allowed for host "api.example.com".',
				logs: [],
			})

		try {
			const sessionClient = {
				openSession: vi.fn(async () => ({
					id: 'job-runtime-job-1',
					source_id: 'source-secret-policy',
					source_root: '/',
					base_commit: 'commit-secret-policy',
					conversation_id: null,
					last_checkpoint_commit: null,
					last_check_run_id: null,
					last_check_tree_hash: null,
					expires_at: null,
					created_at: '2026-04-16T00:00:00.000Z',
					updated_at: '2026-04-16T00:00:00.000Z',
					published_commit: 'commit-secret-policy',
					manifest_path: 'package.json',
					entity_type: 'job' as const,
				})),
				runChecks: vi.fn(async () => ({
					ok: true,
					results: [],
					manifest: createPackageJobManifest({
						packageName: '@kody/forbidden-secret-access',
						kodyId: 'forbidden-secret-access',
						description: 'Runs from repo',
						jobName: 'Forbidden secret access',
					}),
				})),
				readFile: vi.fn(async ({ path }: { path: string }) => ({
					path,
					content:
						path === 'package.json'
							? createPackageJobManifestText({
									packageName: '@kody/forbidden-secret-access',
									kodyId: 'forbidden-secret-access',
									description: 'Runs from repo',
									jobName: 'Forbidden secret access',
								})
							: 'export default async () => ({ ok: true })',
				})),
				tree: vi.fn(async () => ({
					path: '',
					name: '',
					type: 'directory' as const,
					size: 0,
					children: [
						{
							path: 'src/job.ts',
							name: 'job.ts',
							type: 'file' as const,
							size: 1,
						},
					],
				})),
				discardSession: vi.fn(),
			}
			const repoSessionRpcSpy = vi
				.spyOn(
					await import('#worker/repo/repo-session-do.ts'),
					'repoSessionRpc',
				)
				.mockReturnValue(sessionClient as never)
			const outcome = await executeJobOnce({
				env,
				job,
				callerContext,
			})
			expect(outcome.execution).toEqual({
				ok: false,
				error: 'Secret "apiToken" is not allowed for host "api.example.com".',
				logs: [],
			})
			repoSessionRpcSpy.mockRestore()
		} finally {
			executeSpy.mockRestore()
		}
	}
})

test('executeJobOnce retries claimed platform blips and surfaces them on run-now', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const env = createJobServiceTestEnv({
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
		LOADER: {} as WorkerLoader,
		REPO_SESSION: {} as DurableObjectNamespace,
		STORAGE_RUNNER: createStorageRunnerBinding(),
	})
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const jobView = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Platform blip retry job',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})
	await insertPublishedEntitySource({
		db,
		env,
		userId: callerContext.user.userId,
		sourceId: jobView.sourceId,
		entityKind: 'job',
		entityId: jobView.id,
		publishedCommit: 'published-commit-platform-blip',
		manifestPath: 'kody.json',
		files: {
			'kody.json': JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Platform blip retry job',
				description: 'Retries claimed platform blips',
				sourceRoot: '/',
				entrypoint: 'src/job.ts',
			}),
			'src/job.ts': 'export default async () => ({ ok: true })',
		},
	})
	const estimateError = createStorageEstimateReadError({
		storageId: 'package:estimate-target',
		attempts: 4,
		cause: new Error('Storage estimate read timed out after 2000ms.'),
	})
	const executeSpy = vi.spyOn(
		await import('#mcp/run-kody-registry.ts'),
		'runBundledModuleWithRegistry',
	)
	const row = await (
		await import('@kody-internal/shared/jobs/repo.ts')
	).getJobRowById(db, callerContext.user.userId, jobView.id)
	if (!row) {
		throw new Error('Expected created job row.')
	}
	const claimedHandle = {
		id: 'run-platform-blip-claimed',
		userId: callerContext.user.userId,
		startedAt: '2026-08-21T14:40:00.000Z',
		persistence: 'eager' as const,
		context: {
			surface: 'job' as const,
			name: row.record.name,
			jobId: row.record.id,
			storageId: row.record.storageId,
		},
	}

	try {
		const platformBlips = [
			estimateError.message,
			durableObjectInstanceInactiveCloseMessage,
			`D1_ERROR: ${d1NetworkConnectionLostMessage}.`,
		]
		for (const error of platformBlips) {
			executeSpy.mockResolvedValue({
				result: undefined,
				error,
				logs: [],
			})
			const runNow = await executeJobOnce({
				env,
				job: row.record,
				callerContext,
			})
			expect(runNow.execution).toEqual({
				ok: false,
				error,
				logs: [],
			})
			await expect(
				executeJobOnce({
					env,
					job: row.record,
					callerContext,
					runRecordHandle: claimedHandle,
				}),
			).rejects.toBeInstanceOf(TransientJobExecutionError)
		}

		executeSpy.mockResolvedValue({
			result: undefined,
			error: 'user code failed',
			logs: [],
		})
		const userCode = await executeJobOnce({
			env,
			job: row.record,
			callerContext,
			runRecordHandle: claimedHandle,
		})
		expect(userCode.execution).toEqual({
			ok: false,
			error: 'user code failed',
			logs: [],
		})
	} finally {
		executeSpy.mockRestore()
	}
})

test('runJobNow retains once jobs for retention cleanup instead of deleting them', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	const env = createJobServiceTestEnv({
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
		REPO_SESSION: {} as DurableObjectNamespace,
	}) as Env & { CAPABILITY_VECTOR_INDEX?: Pick<VectorizeIndex, 'deleteByIds'> }
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const jobView = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Run once and retain',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
		},
	})
	const deleteByIds = vi.fn(async () => {})
	env.CAPABILITY_VECTOR_INDEX = {
		deleteByIds,
	}
	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: `job-runtime-${jobView.id}`,
			source_id: `${jobView.id}`,
			source_root: '/',
			base_commit: 'published-commit-1',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'published-commit-1',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: true,
			results: [],
			manifest: {
				name: '@kody/run-once',
				exports: {
					'.': './src/index.ts',
				},
				kody: {
					id: 'run-once',
					description: 'Runs from repo',
					jobs: {
						'Run once and retain': {
							entry: './src/job.ts',
							schedule: {
								type: 'once',
								runAt: '2026-04-17T15:00:00Z',
							},
						},
					},
				},
			},
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? JSON.stringify({
							name: '@kody/run-once',
							exports: {
								'.': './src/index.ts',
							},
							kody: {
								id: 'run-once',
								description: 'Runs from repo',
								jobs: {
									'Run once and retain': {
										entry: './src/job.ts',
										schedule: {
											type: 'once',
											runAt: '2026-04-17T15:00:00Z',
										},
									},
								},
							},
						})
					: 'export default async () => ({ ok: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(),
	}
	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true },
			logs: [],
		})

	try {
		const result = await runJobNow({
			env: env as Env,
			userId: callerContext.user.userId,
			jobId: jobView.id,
			callerContext,
		})
		expect(result.execution).toEqual({
			ok: true,
			result: { ok: true },
			logs: [],
		})
		expect(result.deletedAfterRun).toBe(false)
		expect(deleteByIds).not.toHaveBeenCalled()
		const row = await (
			await import('@kody-internal/shared/jobs/repo.ts')
		).getJobRowById(db, callerContext.user.userId, jobView.id)
		expect(row?.record).toEqual(
			expect.objectContaining({
				id: jobView.id,
				enabled: false,
				lastRunStatus: 'success',
				lastRunAt: expect.any(String),
				// RunLog-owned counters/error/duration stay at insert defaults.
				runCount: 0,
				successCount: 0,
				errorCount: 0,
				lastRunError: undefined,
				lastDurationMs: undefined,
			}),
		)
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('runJobNow can use a one-off repo check policy override without changing the stored job', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	await insertPublishedEntitySource({
		db,
		userId: 'user-123',
		sourceId: 'source-run-now-override',
		entityKind: 'package',
		entityId: 'job-repo-run-now-override',
		publishedCommit: 'commit-run-now-override',
		manifestPath: 'package.json',
	})
	const env = createJobServiceTestEnv({
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
		LOADER: {} as WorkerLoader,
	})
	const callerContext = createBaseCallerContext()
	mockRepoPersistence()
	const jobView = await insertLeftoverJob({
		env,
		callerContext,
		body: {
			name: 'Repo-backed run-now override',
			code: 'export default async () => ({ ok: true })',
			sourceId: 'source-run-now-override',
			publishedCommit: 'commit-run-now-override',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})
	await insertPublishedEntitySource({
		db,
		env,
		userId: callerContext.user.userId,
		sourceId: jobView.sourceId,
		entityKind: 'job',
		entityId: jobView.id,
		publishedCommit: 'published-commit-1',
		manifestPath: 'kody.json',
		files: buildJobSourceFiles({
			job: jobView,
			moduleSource:
				'export default async function run() { return { ok: true, override: true } }',
		}),
	})

	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: `job-runtime-${jobView.id}`,
			source_id: 'source-run-now-override',
			source_root: '/',
			base_commit: 'commit-run-now-override',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-run-now-override',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: false,
			results: [
				{
					kind: 'typecheck' as const,
					ok: false,
					message: "src/job.ts:1:28 Cannot find name 'kody'.",
				},
			],
			manifest: {
				name: '@kody/run-now-override',
				exports: {
					'.': './src/index.ts',
				},
				kody: {
					id: 'run-now-override',
					description: 'Runs from repo',
					jobs: {
						'Repo-backed run-now override': {
							entry: './src/job.ts',
							schedule: {
								type: 'interval',
								every: '15m',
							},
						},
					},
				},
			},
			runId: 'check-run-run-now-override',
			treeHash: 'tree-hash-run-now-override',
			checkedAt: '2026-04-16T00:00:00.000Z',
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? JSON.stringify({
							name: '@kody/run-now-override',
							exports: {
								'.': './src/index.ts',
							},
							kody: {
								id: 'run-now-override',
								description: 'Runs from repo',
								jobs: {
									'Repo-backed run-now override': {
										entry: './src/job.ts',
										schedule: {
											type: 'interval',
											every: '15m',
										},
									},
								},
							},
						})
					: 'export default async () => ({ ok: true, override: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true, override: true },
			logs: ['repo-backed kody executed'],
		})

	try {
		const result = await runJobNow({
			env,
			userId: callerContext.user.userId,
			jobId: jobView.id,
			callerContext,
			repoCheckPolicyOverride: {
				allowTypecheckFailures: true,
			},
		})

		expect(result.execution).toEqual({
			ok: true,
			result: { ok: true, override: true },
			logs: ['repo-backed kody executed'],
		})
		const row = await (
			await import('@kody-internal/shared/jobs/repo.ts')
		).getJobRowById(db, callerContext.user.userId, jobView.id)
		expect(row?.record.repoCheckPolicy).toBeUndefined()
		expect(executeSpy).toHaveBeenCalledTimes(1)
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})
