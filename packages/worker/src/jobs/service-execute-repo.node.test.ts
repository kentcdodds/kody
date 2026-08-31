import { expect, test, vi, afterEach } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { executeJobOnce } from './service.ts'
import { type JobRecord } from './types.ts'
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

test('executeJobOnce repo-backed job execution workflow', async () => {
	// Phase: repo-backed one-off jobs from kody.json manifests
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
				name: 'Capability-created one-off job',
				code: 'export default async () => ({ ok: true, adHoc: true })',
				params: {
					step: 'lights-off',
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
					title: 'Capability-created one-off job',
					description: 'Runs once at 2026-04-17T15:00:00.000Z',
					sourceRoot: '/',
					entrypoint: 'src/job.ts',
				}),
				'src/job.ts': 'export default async () => ({ ok: true, adHoc: true })',
			},
		})

		const executeSpy = vi
			.spyOn(
				await import('#mcp/run-kody-registry.ts'),
				'runBundledModuleWithRegistry',
			)
			.mockResolvedValue({
				result: {
					ok: true,
					adHoc: true,
				},
				logs: ['ad hoc job executed'],
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
									title: 'Capability-created one-off job',
									description: 'Runs once at 2026-04-17T15:00:00.000Z',
									sourceRoot: '/',
									entrypoint: 'src/job.ts',
								})
							: 'export default async () => ({ ok: true, adHoc: true })',
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

			expect(outcome.execution).toEqual({
				ok: true,
				result: {
					ok: true,
					adHoc: true,
				},
				logs: ['ad hoc job executed'],
			})
			expect(sessionClient.runChecks).not.toHaveBeenCalled()
			expect(sessionClient.readFile).not.toHaveBeenCalled()
			expect(executeSpy).toHaveBeenCalledTimes(1)
			expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({
				repoContext: expect.objectContaining({
					entityKind: 'job',
					entityId: jobView.id,
					manifestPath: 'kody.json',
				}),
			})
			expect(executeSpy.mock.calls[0]?.[4]).toMatchObject({
				storageTools: {
					userId: 'user-123',
					storageId: `job:${jobView.id}`,
					writable: true,
				},
				runRecord: {
					surface: 'job',
					name: 'Capability-created one-off job',
					jobId: jobView.id,
					storageId: `job:${jobView.id}`,
					sourceId: jobView.sourceId,
					publishedCommit: 'published-commit-1',
				},
			})
			expect(executeSpy.mock.calls[0]?.[4]).not.toHaveProperty(
				'runRecord.packageId',
			)
			expect(executeSpy.mock.calls[0]?.[4]).not.toHaveProperty(
				'runRecord.kodyId',
			)
			repoSessionRpcSpy.mockRestore()
		} finally {
			executeSpy.mockRestore()
		}
	}

	// Phase: repo session refresh when base commit moves
	{
		silenceIncidentalRuntimeWarnings()
		const db = createDatabase()
		const bundleKv = createBundleArtifactsKv()
		await insertPublishedEntitySource({
			db,
			userId: 'user-123',
			sourceId: 'source-1',
			entityKind: 'package',
			entityId: 'job-repo-1',
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
			files: {
				'package.json': createPackageJobManifestText({
					packageName: '@kody/repo-backed-job',
					kodyId: 'repo-backed-job',
					description: 'Runs from repo',
					jobName: 'Repo-backed job',
					entry: './src/job.ts',
				}),
				'src/job.ts':
					'export default async () => ({ ok: true, repoBacked: true })',
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
			id: 'job-repo-1',
			userId: callerContext.user.userId,
			name: 'Repo-backed job',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			storageId: 'job:job-repo-1',
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
		const sessionClient = {
			openSession: vi
				.fn()
				.mockResolvedValueOnce({
					id: 'job-runtime-job-repo-1',
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
					entity_type: 'job',
				})
				.mockResolvedValueOnce({
					id: 'job-runtime-job-repo-1',
					source_id: 'source-1',
					source_root: '/',
					base_commit: 'commit-1',
					conversation_id: null,
					last_checkpoint_commit: null,
					last_check_run_id: null,
					last_check_tree_hash: null,
					expires_at: null,
					created_at: '2026-04-16T00:00:00.000Z',
					updated_at: '2026-04-16T00:00:00.000Z',
					published_commit: 'commit-1',
					manifest_path: 'package.json',
					entity_type: 'job',
				}),
			runChecks: vi.fn(async () => ({
				ok: true,
				results: [],
				manifest: createPackageJobManifest({
					packageName: '@kody/repo-backed-job',
					kodyId: 'repo-backed-job',
					description: 'Runs from repo',
					jobName: 'Repo-backed job',
					entry: './src/job.ts',
				}),
			})),
			readFile: vi.fn(async ({ path }: { path: string }) => ({
				path,
				content:
					path === 'package.json'
						? createPackageJobManifestText({
								packageName: '@kody/repo-backed-job',
								kodyId: 'repo-backed-job',
								description: 'Runs from repo',
								jobName: 'Repo-backed job',
								entry: './src/job.ts',
							})
						: 'export default async () => ({ ok: true, repoBacked: true })',
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
			discardSession: vi.fn(async () => ({
				ok: true as const,
				sessionId: 'job-runtime-job-repo-1',
				deleted: true,
			})),
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
				result: { ok: true, repoBacked: true },
				logs: ['repo-backed kody executed'],
			})

		try {
			const outcome = await executeJobOnce({
				env,
				job,
				callerContext,
			})

			expect(outcome.execution).toEqual({
				ok: true,
				result: { ok: true, repoBacked: true },
				logs: ['repo-backed kody executed'],
			})
			expect(executeSpy).toHaveBeenCalledTimes(1)
		} finally {
			repoSessionRpcSpy.mockRestore()
			executeSpy.mockRestore()
		}
	}

	// Phase: stale published job bundle rebuild after source commit changes
	{
		silenceIncidentalRuntimeWarnings()
		const db = createDatabase()
		const bundleKv = createBundleArtifactsKv()
		await insertPublishedEntitySource({
			db,
			userId: 'user-123',
			sourceId: 'source-stale-bundle',
			entityKind: 'job',
			entityId: 'job-stale-bundle',
			publishedCommit: 'commit-1',
			manifestPath: 'kody.json',
			kv: bundleKv,
			files: {
				'kody.json': JSON.stringify({
					version: 1,
					kind: 'job',
					title: 'Stale bundle job',
					description: 'Runs stale bundle test',
					keywords: ['job'],
					searchText: 'Runs stale bundle test',
					entrypoint: 'src/job.ts',
				}),
				'src/job.ts': 'export default async () => ({ version: "old" })',
			},
		})
		const { persistPublishedBundleArtifact } =
			await import('#worker/package-runtime/published-bundle-artifacts.ts')
		const source = await (
			await import('#worker/repo/entity-sources.ts')
		).getEntitySourceById(db, 'source-stale-bundle')
		if (!source) {
			throw new Error('Expected source row.')
		}
		await persistPublishedBundleArtifact({
			env: {
				APP_DB: db,
				BUNDLE_ARTIFACTS_KV: bundleKv,
			} as Env,
			userId: 'user-123',
			source,
			kind: 'job',
			artifactName: 'job-stale-bundle',
			entryPoint: 'src/job.ts',
			mainModule: 'dist/bundled-entry.js',
			modules: {
				'dist/bundled-entry.js':
					'export default async () => ({ version: "old-bundle" })',
			},
			dependencies: [],
			packageContext: null,
		})
		await insertPublishedEntitySource({
			db,
			userId: 'user-123',
			sourceId: 'source-stale-bundle',
			entityKind: 'job',
			entityId: 'job-stale-bundle',
			publishedCommit: 'commit-2',
			manifestPath: 'kody.json',
			kv: bundleKv,
			files: {
				'kody.json': JSON.stringify({
					version: 1,
					kind: 'job',
					title: 'Stale bundle job',
					description: 'Runs stale bundle test',
					keywords: ['job'],
					searchText: 'Runs stale bundle test',
					entrypoint: 'src/job.ts',
				}),
				'src/job.ts':
					'export default async () => { console.log("canary"); return { version: "new" } }',
			},
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
			id: 'job-stale-bundle',
			userId: callerContext.user.userId,
			name: 'Stale bundle job',
			sourceId: 'source-stale-bundle',
			publishedCommit: 'commit-2',
			storageId: 'job:job-stale-bundle',
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
				result: { ok: true, version: 'new' },
				logs: ['canary'],
			})

		try {
			const outcome = await executeJobOnce({
				env,
				job,
				callerContext,
			})

			expect(outcome.execution).toEqual({
				ok: true,
				result: { ok: true, version: 'new' },
				logs: ['canary'],
			})
			expect(executeSpy).toHaveBeenCalledTimes(1)
			const executedBundle = executeSpy.mock.calls[0]?.[2]
			const executedModules = Object.values(executedBundle?.modules ?? {}).join(
				'\n',
			)
			expect(executedModules).toContain('userEntrypoint')
			expect(executedModules).not.toContain('old-bundle')
		} finally {
			executeSpy.mockRestore()
		}
	}
})

test('executeJobOnce repo session bundling and check policy workflow', async () => {
	// Phase: package-backed jobs from published artifacts
	{
		silenceIncidentalRuntimeWarnings()
		const db = createDatabase()
		const bundleKv = createBundleArtifactsKv()
		await insertPublishedEntitySource({
			db,
			userId: 'user-123',
			sourceId: 'source-strict',
			entityKind: 'package',
			entityId: 'job-repo-typecheck-strict',
			publishedCommit: 'commit-strict',
			manifestPath: 'package.json',
			kv: bundleKv,
			files: {
				'package.json': createPackageJobManifestText({
					packageName: '@kody/repo-typecheck-strict',
					kodyId: 'repo-typecheck-strict',
					description: 'Runs from repo',
					jobName: 'Repo-backed strict typecheck job',
					entry: './src/custom-job.ts',
				}),
				'src/custom-job.ts': 'export default async () => ({ ok: true })',
			},
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
			id: 'job-repo-typecheck-strict',
			userId: callerContext.user.userId,
			name: 'Repo-backed strict typecheck job',
			sourceId: 'source-strict',
			publishedCommit: 'commit-strict',
			storageId: 'job:job-repo-typecheck-strict',
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
		const sessionClient = {
			openSession: vi.fn(async () => ({
				id: 'job-runtime-job-repo-typecheck-strict',
				source_id: 'source-strict',
				source_root: '/',
				base_commit: 'commit-strict',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'commit-strict',
				manifest_path: 'package.json',
				entity_type: 'job' as const,
			})),
			runChecks: vi.fn(async () => ({
				ok: false,
				results: [
					{
						kind: 'typecheck' as const,
						ok: false,
						message: "src/custom-job.ts:1:28 Cannot find name 'kody'.",
					},
				],
				manifest: createPackageJobManifest({
					packageName: '@kody/repo-typecheck-strict',
					kodyId: 'repo-typecheck-strict',
					description: 'Runs from repo',
					jobName: 'Repo-backed strict typecheck job',
					entry: './src/custom-job.ts',
				}),
				runId: 'check-run-strict',
				treeHash: 'tree-hash-strict',
				checkedAt: '2026-04-16T00:00:00.000Z',
			})),
			readFile: vi.fn(),
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
				result: { ok: true, repoBacked: true },
				logs: ['repo-backed kody executed'],
			})

		try {
			const outcome = await executeJobOnce({
				env,
				job,
				callerContext,
			})

			expect(outcome.execution).toEqual({
				ok: true,
				result: { ok: true, repoBacked: true },
				logs: ['repo-backed kody executed'],
			})
			expect(sessionClient.readFile).not.toHaveBeenCalled()
			expect(executeSpy).toHaveBeenCalledTimes(1)
		} finally {
			repoSessionRpcSpy.mockRestore()
			executeSpy.mockRestore()
		}
	}

	// Phase: typecheck-only failure bypass via stored repo policy
	{
		silenceIncidentalRuntimeWarnings()
		const db = createDatabase()
		const bundleKv = createBundleArtifactsKv()
		await insertPublishedEntitySource({
			db,
			userId: 'user-123',
			sourceId: 'source-bypass',
			entityKind: 'package',
			entityId: 'job-repo-typecheck-bypass',
			publishedCommit: 'commit-bypass',
			manifestPath: 'package.json',
			files: {
				'package.json': createPackageJobManifestText({
					packageName: '@kody/repo-typecheck-bypass',
					kodyId: 'repo-typecheck-bypass',
					description: 'Runs from repo',
					jobName: 'Repo-backed bypass typecheck job',
				}),
				'src/job.ts':
					'export default async () => ({ ok: true, bypassed: true })',
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
			id: 'job-repo-typecheck-bypass',
			userId: callerContext.user.userId,
			name: 'Repo-backed bypass typecheck job',
			sourceId: 'source-bypass',
			publishedCommit: 'commit-bypass',
			repoCheckPolicy: {
				allowTypecheckFailures: true,
			},
			storageId: 'job:job-repo-typecheck-bypass',
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
		const sessionClient = {
			openSession: vi.fn(async () => ({
				id: 'job-runtime-job-repo-typecheck-bypass',
				source_id: 'source-bypass',
				source_root: '/',
				base_commit: 'commit-bypass',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'commit-bypass',
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
				manifest: createPackageJobManifest({
					packageName: '@kody/repo-typecheck-bypass',
					kodyId: 'repo-typecheck-bypass',
					description: 'Runs from repo',
					jobName: 'Repo-backed bypass typecheck job',
				}),
				runId: 'check-run-bypass',
				treeHash: 'tree-hash-bypass',
				checkedAt: '2026-04-16T00:00:00.000Z',
			})),
			readFile: vi.fn(async ({ path }: { path: string }) => ({
				path,
				content:
					path === 'package.json'
						? createPackageJobManifestText({
								packageName: '@kody/repo-typecheck-bypass',
								kodyId: 'repo-typecheck-bypass',
								description: 'Runs from repo',
								jobName: 'Repo-backed bypass typecheck job',
							})
						: 'export default async () => ({ ok: true, bypassed: true })',
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
				result: { ok: true, bypassed: true },
				logs: ['repo-backed kody executed'],
			})
		const formatJobErrorSpy = vi.spyOn(
			await import('./schedule.ts'),
			'formatJobError',
		)

		try {
			const outcome = await executeJobOnce({
				env,
				job,
				callerContext,
			})

			expect(outcome.execution).toEqual({
				ok: true,
				result: { ok: true, bypassed: true },
				logs: ['repo-backed kody executed'],
			})
			expect(executeSpy).toHaveBeenCalledTimes(1)

			// Same bypass path must still surface executor failures after the check.
			executeSpy.mockRejectedValueOnce(new Error('Executor import failed'))
			const failedOutcome = await executeJobOnce({
				env,
				job,
				callerContext,
			})
			expect(failedOutcome.execution).toEqual({
				ok: false,
				error: 'Executor import failed',
				logs: [],
			})
			expect(formatJobErrorSpy).toHaveBeenCalled()
		} finally {
			repoSessionRpcSpy.mockRestore()
			executeSpy.mockRestore()
			formatJobErrorSpy.mockRestore()
		}
	}

	// Phase: repo-session absolute paths and migrated entrypoints
	{
		silenceIncidentalRuntimeWarnings()
		const db = createDatabase()
		const bundleKv = createBundleArtifactsKv()
		await insertPublishedEntitySource({
			db,
			userId: 'user-123',
			sourceId: 'source-absolute-paths',
			entityKind: 'package',
			entityId: 'job-repo-absolute-paths',
			publishedCommit: 'commit-absolute',
			manifestPath: 'package.json',
			files: {
				'package.json': createPackageJobManifestText({
					packageName: '@kody/repo-absolute-path-job',
					kodyId: 'repo-absolute-path-job',
					description: 'Runs from repo session files',
					jobName: 'Repo-backed absolute path job',
					exportPath: './src/job.ts',
				}),
				'src/job.ts':
					'export default async () => ({ ok: true, normalized: true })',
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
			id: 'job-repo-absolute-paths',
			userId: callerContext.user.userId,
			name: 'Repo-backed absolute path job',
			code: null,
			sourceId: 'source-absolute-paths',
			publishedCommit: 'commit-absolute',
			storageId: 'job:job-repo-absolute-paths',
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

		const sessionClient = {
			openSession: vi.fn(async () => ({
				id: 'job-runtime-job-repo-absolute-paths',
				source_id: 'source-absolute-paths',
				source_root: '/',
				base_commit: 'commit-absolute',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'commit-absolute',
				manifest_path: 'package.json',
				entity_type: 'job' as const,
			})),
			runChecks: vi.fn(async () => {
				const { runRepoChecks } = await import('#worker/repo/checks.ts')
				return runRepoChecks({
					workspace: {
						async readFile(path: string) {
							const file = workspaceFiles.get(path)
							return (
								file ?? workspaceFiles.get(path.replace(/^\/+/, '')) ?? null
							)
						},
						async glob() {
							return Array.from(workspaceFiles.keys()).map((path) => ({
								path,
								type: 'file',
							}))
						},
					},
					manifestPath: '/session/package.json',
					sourceRoot: '/session/',
				})
			}),
			readFile: vi.fn(async ({ path }: { path: string }) => ({
				path,
				content:
					path === 'package.json'
						? createPackageJobManifestText({
								packageName: '@kody/repo-absolute-path-job',
								kodyId: 'repo-absolute-path-job',
								description: 'Runs from repo session files',
								jobName: 'Repo-backed absolute path job',
								exportPath: './src/job.ts',
							})
						: 'export default async () => ({ ok: true, normalized: true })',
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
					{
						path: 'package.json',
						name: 'package.json',
						type: 'file' as const,
						size: 1,
					},
				],
			})),
			discardSession: vi.fn(async () => ({
				ok: true as const,
				sessionId: 'job-runtime-job-repo-absolute-paths',
				deleted: true,
			})),
		}
		const workspaceFiles = new Map<string, string>([
			[
				'/session/package.json',
				createPackageJobManifestText({
					packageName: '@kody/repo-absolute-path-job',
					kodyId: 'repo-absolute-path-job',
					description: 'Runs from repo session files',
					jobName: 'Repo-backed absolute path job',
					exportPath: './src/job.ts',
				}),
			],
			['/session/src/job.ts', 'export default async () => ({ ok: true })\n'],
		])

		const repoSessionRpcSpy = vi
			.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
			.mockReturnValue(sessionClient as never)
		const executeSpy = vi
			.spyOn(
				await import('#mcp/run-kody-registry.ts'),
				'runBundledModuleWithRegistry',
			)
			.mockResolvedValue({
				result: { ok: true, normalized: true },
				logs: ['repo-backed kody executed'],
			})

		try {
			const outcome = await executeJobOnce({
				env,
				job,
				callerContext,
			})

			expect(outcome.execution).toEqual({
				ok: true,
				result: { ok: true, normalized: true },
				logs: ['repo-backed kody executed'],
			})
			expect(executeSpy).toHaveBeenCalledTimes(1)
		} finally {
			repoSessionRpcSpy.mockRestore()
			executeSpy.mockRestore()
		}
	}

	// Phase: ESM repo-backed job entrypoint bundling
	{
		silenceIncidentalRuntimeWarnings()
		const db = createDatabase()
		const bundleKv = createBundleArtifactsKv()
		await insertPublishedEntitySource({
			db,
			userId: 'user-123',
			sourceId: 'source-job-repo-module',
			entityKind: 'package',
			entityId: 'job-repo-module',
			publishedCommit: 'commit-abc',
			manifestPath: 'package.json',
			env: {
				APP_DB: db,
				BUNDLE_ARTIFACTS_KV: bundleKv,
			} as Env,
			files: {
				'package.json': createPackageJobManifestText({
					packageName: '@kody/repo-module-job',
					kodyId: 'repo-module-job',
					description: 'Runs from repo',
					jobName: 'Repo-backed module job',
				}),
				'src/job.ts':
					'export default async () => ({ ok: true, repoBacked: "module" })',
				'src/lib.ts': 'export const value = 1',
			},
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
			id: 'job-repo-module',
			userId: callerContext.user.userId,
			name: 'Repo-backed module job',
			code: null,
			sourceId: 'source-job-repo-module',
			publishedCommit: 'commit-abc',
			storageId: 'job:job-repo-module',
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

		const sessionClient = {
			openSession: vi.fn(async () => ({
				id: 'job-runtime-job-repo-module',
				source_id: 'source-job-repo-module',
				source_root: '/',
				base_commit: 'commit-abc',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'commit-abc',
				manifest_path: 'package.json',
				entity_type: 'job' as const,
			})),
			runChecks: vi.fn(async () => ({
				ok: true,
				results: [],
				manifest: createPackageJobManifest({
					packageName: '@kody/repo-module-job',
					kodyId: 'repo-module-job',
					description: 'Runs from repo',
					jobName: 'Repo-backed module job',
				}),
			})),
			readFile: vi.fn(async ({ path }: { path: string }) => ({
				path,
				content:
					path === 'package.json'
						? createPackageJobManifestText({
								packageName: '@kody/repo-module-job',
								kodyId: 'repo-module-job',
								description: 'Runs from repo',
								jobName: 'Repo-backed module job',
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
					{
						path: 'src/lib.ts',
						name: 'lib.ts',
						type: 'file' as const,
						size: 1,
					},
					{
						path: 'package.json',
						name: 'package.json',
						type: 'file' as const,
						size: 1,
					},
				],
			})),
			discardSession: vi.fn(async () => ({
				ok: true as const,
				sessionId: 'job-runtime-job-repo-module',
				deleted: true,
			})),
		}

		const repoSessionRpcSpy = vi
			.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
			.mockReturnValue(sessionClient as never)
		const executeSpy = vi.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
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
		const bundleSpy = vi.spyOn(
			await import('#worker/package-runtime/module-graph.ts'),
			'buildKodyModuleBundle',
		)
		const loadFilesSpy = vi.spyOn(
			await import('#worker/repo/repo-kody-execution.ts'),
			'loadRepoSourceFilesFromSession',
		)

		try {
			loadFilesSpy.mockResolvedValue({
				'package.json': JSON.stringify({
					name: 'repo-module-job',
					private: true,
				}),
				'src/job.ts':
					'export default async () => ({ ok: true, repoBacked: "module" })',
				'src/lib.ts': 'export const value = 1',
			})
			bundleSpy.mockResolvedValue({
				mainModule: 'dist/job.js',
				modules: {
					'dist/job.js':
						'export default async () => ({ ok: true, repoBacked: "module" })',
				},
				dependencies: [],
			})
			executeSpy.mockResolvedValue({
				result: { ok: true, repoBacked: 'module' },
				logs: ['repo-backed kody executed'],
			})
			const outcome = await executeJobOnce({
				env,
				job,
				callerContext,
			})

			expect(outcome.execution).toEqual({
				ok: true,
				result: { ok: true, repoBacked: 'module' },
				logs: ['repo-backed kody executed'],
			})
			expect(executeSpy).toHaveBeenCalledTimes(1)
			expect(executeSpy.mock.calls[0]?.[4]).toMatchObject({
				storageTools: {
					userId: 'user-123',
					storageId: 'job:job-repo-module',
					writable: true,
				},
				packageContext: {
					packageId: 'job-repo-module',
					kodyId: 'repo-module-job',
				},
				packageInvokeTools: expect.objectContaining({
					invoke: expect.any(Function),
				}),
			})
			expect(runtimeInvokeSpy).toHaveBeenCalledTimes(1)
			expect(executeInvokeSpy).not.toHaveBeenCalled()
		} finally {
			repoSessionRpcSpy.mockRestore()
			executeSpy.mockRestore()
			executeInvokeSpy.mockRestore()
			runtimeInvokeSpy.mockRestore()
			bundleSpy.mockRestore()
			loadFilesSpy.mockRestore()
		}
	}
})
