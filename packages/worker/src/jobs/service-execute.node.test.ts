import { expect, test, vi, afterEach } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { planLimits } from '#universal/plans.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { saveValue } from '#mcp/values/service.ts'
import { executeJobOnce } from './service.ts'
import { type JobRecord } from './types.ts'
import { TransientJobExecutionError } from './execution-safety.ts'
import {
	identityMockModule,
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

test('executeJobOnce background execution workflow', async () => {
	// Phase: job_runs_per_day entitlement before sandbox work
	{
		// Usage rollup writes are best-effort and fail against this fake env.
		silenceIncidentalRuntimeWarnings()
		const { utcDayKey } = await import('@kody-internal/shared/date-keys.ts')
		const { parseEntitlementLimitMessage } =
			await import('#worker/entitlements/errors.ts')
		const usageModule = await import('#worker/usage/record-usage.ts')
		const recordUsageSpy = vi
			.spyOn(usageModule, 'recordUsage')
			.mockResolvedValue(undefined)
		const callerContext = createBaseCallerContext()
		const userId = callerContext.user.userId
		// Matches the module-level resolveBackgroundMcpUser mock email.
		const email = `${userId}@example.com`
		const meter = createInMemoryUserMeterEnv()
		const env = createJobServiceTestEnv(
			{
				APP_DB: createDatabase({
					users: [{ email, plan: 'free', stable_user_id: userId }],
				}),
			},
			meter,
		)
		const limit = planLimits.free.maxJobRunsPerDay
		await meter.seed({
			userId,
			resource: 'job_runs_per_day',
			day: utcDayKey(),
			count: limit,
		})

		const executeSpy = vi.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		const job: JobRecord = {
			version: 1,
			id: 'job-run-quota',
			userId,
			name: 'Quota job',
			sourceId: 'source-job-run-quota',
			publishedCommit: null,
			storageId: 'job:job-run-quota',
			schedule: { type: 'interval', every: '1h' },
			timezone: 'UTC',
			enabled: true,
			killSwitchEnabled: false,
			preserved: false,
			expiresAt: null,
			createdAt: '2026-08-08T00:00:00.000Z',
			updatedAt: '2026-08-08T00:00:00.000Z',
			nextRunAt: '2026-08-08T13:00:00.000Z',
			runCount: 0,
			successCount: 0,
			errorCount: 0,
		}

		try {
			const outcome = await executeJobOnce({
				env,
				job,
				callerContext,
			})
			expect(outcome.execution.ok).toBe(false)
			if (outcome.execution.ok) {
				throw new Error('Expected job_runs_per_day denial.')
			}
			const details = parseEntitlementLimitMessage(outcome.execution.error)
			expect(details).toMatchObject({
				code: 'entitlement_limit_exceeded',
				resource: 'job_runs_per_day',
				plan: 'free',
				limit,
				current: limit,
			})
			expect(executeSpy).not.toHaveBeenCalled()
			expect(recordUsageSpy).not.toHaveBeenCalled()
		} finally {
			executeSpy.mockRestore()
			recordUsageSpy.mockRestore()
		}
	}

	// Phase: transient background identity lookup retry
	{
		const callerContext = createBaseCallerContext()
		const env = createJobServiceTestEnv({ APP_DB: createDatabase() })
		identityMockModule.resolveBackgroundMcpUser.mockRejectedValueOnce(
			new Error('D1_ERROR: Network connection lost.'),
		)
		const job: JobRecord = {
			version: 1,
			id: 'job-identity-retry',
			userId: callerContext.user.userId,
			name: 'Identity retry',
			sourceId: 'source-identity-retry',
			publishedCommit: null,
			storageId: 'job:job-identity-retry',
			schedule: { type: 'interval', every: '1h' },
			timezone: 'UTC',
			enabled: true,
			killSwitchEnabled: false,
			preserved: false,
			expiresAt: null,
			createdAt: '2026-08-08T00:00:00.000Z',
			updatedAt: '2026-08-08T00:00:00.000Z',
			nextRunAt: '2026-08-08T01:00:00.000Z',
			runCount: 0,
			successCount: 0,
			errorCount: 0,
		}

		await expect(
			executeJobOnce({
				env,
				job,
				callerContext,
			}),
		).rejects.toBeInstanceOf(TransientJobExecutionError)
	}

	// Phase: writable storage binding and interactive origin override
	{
		// Usage rollup writes are best-effort and fail against this fake env.
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
		const callerContext = {
			...createBaseCallerContext(),
			executionOrigin: 'interactive' as const,
		}

		const jobView = await insertLeftoverJob({
			env,
			callerContext,
			body: {
				name: 'Storage bridge',
				code: 'export default async (params) => { await storage.set("count", params.stepCount); return await storage.sql("select 2 as value") }',
				params: {
					stepCount: 2,
				},
				schedule: {
					type: 'once',
					runAt: '2026-04-17T15:00:00Z',
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
			files: {
				'kody.json': JSON.stringify({
					version: 1,
					kind: 'job',
					title: 'Storage bridge',
					description: 'Runs once at 2026-04-17T15:00:00.000Z',
					sourceRoot: '/',
					entrypoint: 'src/job.ts',
				}),
				'src/job.ts':
					'export default async (params) => { await storage.set("count", params.stepCount); return await storage.sql("select 2 as value") }',
			},
		})

		const executeSpy = vi
			.spyOn(
				await import('#mcp/run-kody-registry.ts'),
				'runBundledModuleWithRegistry',
			)
			.mockResolvedValue({
				result: {
					value: 2,
				},
				logs: ['storage helper executed'],
			})
		const packageInvocations =
			await import('#worker/package-invocations/service.ts')
		const executeInvokeSpy = vi.spyOn(
			packageInvocations,
			'createExecutePackageInvokeTools',
		)
		const runtimeInvokeSpy = vi.spyOn(
			packageInvocations,
			'createPackageRuntimeInvokeTools',
		)

		try {
			const sessionClient = {
				openSession: vi.fn(async () => ({
					id: `job-runtime-${jobView.id}`,
					source_id: jobView.sourceId,
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
					manifest: createPackageJobManifest({
						packageName: '@kody/storage-bridge',
						kodyId: 'storage-bridge',
						description: 'Runs from repo',
						jobName: 'Storage bridge',
					}),
				})),
				readFile: vi.fn(async ({ path }: { path: string }) => ({
					path,
					content:
						path === 'package.json'
							? createPackageJobManifestText({
									packageName: '@kody/storage-bridge',
									kodyId: 'storage-bridge',
									description: 'Runs from repo',
									jobName: 'Storage bridge',
								})
							: 'export default async (params) => { await storage.set("count", params.stepCount); return await storage.sql("select 2 as value") }',
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
			const row = await (
				await import('@kody-internal/shared/jobs/repo.ts')
			).getJobRowById(db, callerContext.user.userId, jobView.id)
			if (!row) {
				throw new Error('Expected created job row.')
			}
			expect(row.record.storageId).toBe(`job:${jobView.id}`)
			expect(row.callerContext?.executionOrigin).toBe('interactive')
			const outcome = await executeJobOnce({
				env,
				job: row.record,
				callerContext: row.callerContext,
			})

			expect(outcome.execution).toEqual({
				ok: true,
				result: {
					value: 2,
				},
				logs: ['storage helper executed'],
			})
			expect(executeSpy).toHaveBeenCalledWith(
				env,
				expect.objectContaining({
					executionOrigin: 'background',
					user: expect.objectContaining({
						userId: callerContext.user.userId,
						email: 'user-123@example.com',
					}),
				}),
				expect.any(Object),
				expect.any(Object),
				expect.objectContaining({
					storageTools: {
						userId: callerContext.user.userId,
						storageId: `job:${jobView.id}`,
						writable: true,
					},
					packageInvokeTools: expect.objectContaining({
						invoke: expect.any(Function),
					}),
				}),
			)
			expect(executeInvokeSpy).toHaveBeenCalledTimes(1)
			expect(runtimeInvokeSpy).not.toHaveBeenCalled()
			repoSessionRpcSpy.mockRestore()
		} finally {
			executeSpy.mockRestore()
			executeInvokeSpy.mockRestore()
			runtimeInvokeSpy.mockRestore()
		}
	}

	// Phase: attached remote connectors for background execution
	{
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
				name: 'Remote connector bridge',
				code: 'export default async () => ({ ok: true })',
				schedule: {
					type: 'once',
					runAt: '2026-04-17T15:00:00Z',
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
			files: {
				'kody.json': JSON.stringify({
					version: 1,
					kind: 'job',
					title: 'Remote connector bridge',
					description: 'Runs once at 2026-04-17T15:00:00.000Z',
					sourceRoot: '/',
					entrypoint: 'src/job.ts',
				}),
				'src/job.ts': 'export default async () => ({ ok: true })',
			},
		})

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
			const row = await (
				await import('@kody-internal/shared/jobs/repo.ts')
			).getJobRowById(db, callerContext.user.userId, jobView.id)
			if (!row) {
				throw new Error('Expected created job row.')
			}
			await executeJobOnce({
				env,
				job: row.record,
				callerContext: row.callerContext,
			})

			expect(executeSpy).toHaveBeenCalledTimes(1)
			expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({})
		} finally {
			executeSpy.mockRestore()
		}
	}
})

test('executeJobOnce background kody semantics and usage workflow', async () => {
	// Phase: kody secret and value semantics
	{
		silenceIncidentalRuntimeWarnings()
		const db = createDatabase()
		const bundleKv = createBundleArtifactsKv()
		const env = createJobServiceTestEnv({
			APP_DB: db,
			CLOUDFLARE_ACCOUNT_ID: 'acct-test',
			CLOUDFLARE_API_TOKEN: 'token-test',
			BUNDLE_ARTIFACTS_KV: bundleKv,
			COOKIE_SECRET: 'test-secret-0123456789abcdef0123456789',
			LOADER: {} as WorkerLoader,
			REPO_SESSION: {} as DurableObjectNamespace,
		})
		mockRepoPersistence()
		const callerContext = createBaseCallerContext()

		await saveSecret({
			env,
			userId: callerContext.user.userId,
			scope: 'user',
			name: 'apiToken',
			value: 'very-secret-token',
			storageContext: callerContext.storageContext,
		})
		await saveValue({
			env,
			userId: callerContext.user.userId,
			scope: 'app',
			name: 'projectId',
			value: 'alpha-project',
			storageContext: callerContext.storageContext,
		})

		const jobView = await insertLeftoverJob({
			env,
			callerContext,
			body: {
				name: 'Use kody semantics',
				code: 'export default async () => ({ ok: true })',
				params: {
					step: 'deploy',
				},
				schedule: {
					type: 'once',
					runAt: '2026-04-17T15:00:00Z',
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
			files: {
				'kody.json': JSON.stringify({
					version: 1,
					kind: 'job',
					title: 'Use kody semantics',
					description: 'Runs once at 2026-04-17T15:00:00.000Z',
					sourceRoot: '/',
					entrypoint: 'src/job.ts',
				}),
				'src/job.ts': 'export default async () => ({ ok: true })',
			},
		})

		const executeSpy = vi
			.spyOn(
				await import('#mcp/run-kody-registry.ts'),
				'runBundledModuleWithRegistry',
			)
			.mockResolvedValue({
				result: {
					secretValue: 'very-secret-token',
					value: 'alpha-project',
					userId: 'user-123',
					storageId: `job:${jobView.id}`,
				},
				logs: ['kody executed'],
			})

		try {
			const sessionClient = {
				openSession: vi.fn(async () => ({
					id: `job-runtime-${jobView.id}`,
					source_id: jobView.sourceId,
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
					manifest: createPackageJobManifest({
						packageName: '@kody/kody-semantics',
						kodyId: 'kody-semantics',
						description: 'Runs from repo',
						jobName: 'Use kody semantics',
					}),
				})),
				readFile: vi.fn(async ({ path }: { path: string }) => ({
					path,
					content:
						path === 'package.json'
							? createPackageJobManifestText({
									packageName: '@kody/kody-semantics',
									kodyId: 'kody-semantics',
									description: 'Runs from repo',
									jobName: 'Use kody semantics',
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
			const row = await (
				await import('@kody-internal/shared/jobs/repo.ts')
			).getJobRowById(db, callerContext.user.userId, jobView.id)
			if (!row) {
				throw new Error('Expected created job row.')
			}
			const outcome = await executeJobOnce({
				env,
				job: row.record,
				callerContext,
			})

			expect(executeSpy).toHaveBeenCalledTimes(1)

			expect(outcome.execution).toEqual({
				ok: true,
				result: {
					secretValue: 'very-secret-token',
					value: 'alpha-project',
					userId: 'user-123',
					storageId: `job:${jobView.id}`,
				},
				logs: ['kody executed'],
			})
			expect(executeSpy.mock.calls[0]?.[2]).toMatchObject({
				mainModule: 'dist/bundled-entry.js',
			})
			repoSessionRpcSpy.mockRestore()
		} finally {
			executeSpy.mockRestore()
		}
	}

	// Phase: job_run usage recording for success and failure
	{
		const usageModule = await import('#worker/usage/record-usage.ts')
		const recordUsageSpy = vi
			.spyOn(usageModule, 'recordUsage')
			.mockResolvedValue(undefined)
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
				name: 'Usage-metered job',
				code: 'export default async () => ({ ok: true, metered: true })',
				schedule: {
					type: 'once',
					runAt: '2026-04-17T15:00:00Z',
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
			files: {
				'kody.json': JSON.stringify({
					version: 1,
					kind: 'job',
					title: 'Usage-metered job',
					description: 'Runs once at 2026-04-17T15:00:00.000Z',
					sourceRoot: '/',
					entrypoint: 'src/job.ts',
				}),
				'src/job.ts':
					'export default async () => ({ ok: true, metered: true })',
			},
		})
		const executeSpy = vi
			.spyOn(
				await import('#mcp/run-kody-registry.ts'),
				'runBundledModuleWithRegistry',
			)
			.mockResolvedValueOnce({
				result: {
					ok: true,
					metered: true,
				},
				logs: ['metered job executed'],
			})
			.mockResolvedValueOnce({
				error: 'metered job failed',
				result: null,
				logs: ['metered job error'],
			})
		const sessionClient = {
			openSession: vi.fn(async () => ({
				id: `job-runtime-${jobView.id}`,
				source_id: jobView.sourceId,
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
				manifest_path: 'kody.json',
				entity_type: 'job' as const,
			})),
			runChecks: vi.fn(),
			readFile: vi.fn(async ({ path }: { path: string }) => ({
				path,
				content:
					path === 'kody.json'
						? JSON.stringify({
								version: 1,
								kind: 'job',
								title: 'Usage-metered job',
								description: 'Runs once at 2026-04-17T15:00:00.000Z',
								sourceRoot: '/',
								entrypoint: 'src/job.ts',
							})
						: 'export default async () => ({ ok: true, metered: true })',
			})),
			tree: vi.fn(async () => ({
				path: '',
				name: '',
				type: 'directory' as const,
				size: 0,
				children: [
					{
						path: 'kody.json',
						name: 'kody.json',
						type: 'file' as const,
						size: 1,
					},
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
		const row = await (
			await import('@kody-internal/shared/jobs/repo.ts')
		).getJobRowById(db, callerContext.user.userId, jobView.id)
		if (!row) {
			throw new Error('Expected created job row.')
		}

		try {
			const successOutcome = await executeJobOnce({
				env,
				job: row.record,
				callerContext,
			})
			expect(successOutcome.execution).toEqual({
				ok: true,
				result: {
					ok: true,
					metered: true,
				},
				logs: ['metered job executed'],
			})
			expect(successOutcome.durationMs).toEqual(expect.any(Number))
			expect(recordUsageSpy).toHaveBeenCalledTimes(1)
			expect(recordUsageSpy).toHaveBeenCalledWith(env, {
				userId: row.record.userId,
				eventType: 'job_run',
				entityId: jobView.id,
				durationMs: successOutcome.durationMs,
				outcome: 'success',
			})
			expect(successOutcome.durationMs).toBeGreaterThanOrEqual(0)

			recordUsageSpy.mockClear()
			const failureOutcome = await executeJobOnce({
				env,
				job: row.record,
				callerContext,
			})
			expect(failureOutcome.execution).toEqual({
				ok: false,
				error: 'metered job failed',
				logs: ['metered job error'],
			})
			expect(failureOutcome.durationMs).toEqual(expect.any(Number))
			expect(recordUsageSpy).toHaveBeenCalledTimes(1)
			expect(recordUsageSpy).toHaveBeenCalledWith(env, {
				userId: row.record.userId,
				eventType: 'job_run',
				entityId: jobView.id,
				durationMs: failureOutcome.durationMs,
				outcome: 'error',
			})
			expect(failureOutcome.durationMs).toBeGreaterThanOrEqual(0)
		} finally {
			recordUsageSpy.mockRestore()
			repoSessionRpcSpy.mockRestore()
			executeSpy.mockRestore()
		}
	}
})
