import { vi } from 'vitest'

export const repoMockModule = {
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	cleanupArtifactReposForSource: vi.fn(async () => ({
		deleted: 0,
		artifactAccessUnavailable: false,
	})),
	listRepoSessionsBySource: vi.fn(async () => []),
	deleteRepoSessionsBySourceForUser: vi.fn(async () => 0),
	cleanupSessionBranch: vi.fn(async () => ({ ok: true })),
}

export const jobManagerMockModule = {
	syncJobManagerAlarm: vi.fn(),
	getJobManagerDebugState: vi.fn(),
}

export const storageRunnerMockModule = {
	clearStorage: vi.fn(async () => ({ ok: true as const })),
	getEstimatedBytes: vi.fn(async () => ({ estimatedBytes: 0 })),
}

export const identityMockModule = {
	resolveBackgroundMcpUser: vi.fn(async (_db: D1Database, userId: string) => ({
		userId,
		email: `${userId}@example.com`,
		username: userId,
		displayName: userId,
	})),
}

export function sourceServiceMock() {
	return {
		ensureEntitySource: (...args: Array<unknown>) =>
			repoMockModule.ensureEntitySource(...args),
	}
}

export function sourceSyncMock() {
	return {
		syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
			repoMockModule.syncArtifactSourceSnapshot(...args),
	}
}

export function artifactRepoCleanupMock() {
	return {
		cleanupArtifactReposForSource: (...args: Array<unknown>) =>
			repoMockModule.cleanupArtifactReposForSource(...args),
	}
}

export function repoSessionsMock() {
	return {
		listRepoSessionsBySource: (...args: Array<unknown>) =>
			repoMockModule.listRepoSessionsBySource(...args),
		deleteRepoSessionsBySourceForUser: (...args: Array<unknown>) =>
			repoMockModule.deleteRepoSessionsBySourceForUser(...args),
	}
}

export function repoSessionDoMock() {
	return {
		repoSessionRpc: () => ({
			cleanupSessionBranch: (...args: Array<unknown>) =>
				repoMockModule.cleanupSessionBranch(...args),
		}),
	}
}

export function managerClientMock() {
	return {
		syncJobManagerAlarm: (...args: Array<unknown>) =>
			jobManagerMockModule.syncJobManagerAlarm(...args),
		getJobManagerDebugState: (...args: Array<unknown>) =>
			jobManagerMockModule.getJobManagerDebugState(...args),
	}
}

export function backgroundMcpUserMock() {
	return {
		resolveBackgroundMcpUser: (...args: Array<unknown>) =>
			identityMockModule.resolveBackgroundMcpUser(
				...(args as [D1Database, string]),
			),
	}
}

export function storageRunnerMock(actual: Record<string, unknown>) {
	return {
		...actual,
		storageRunnerRpc: () => ({
			clearStorage: (...args: Array<unknown>) =>
				storageRunnerMockModule.clearStorage(...args),
			getEstimatedBytes: (...args: Array<unknown>) =>
				storageRunnerMockModule.getEstimatedBytes(...args),
			getValue: async () => ({ ok: true, key: '', value: null }),
			setValue: async ({ key }: { key: string }) => ({ ok: true, key }),
			deleteValue: async ({ key }: { key: string }) => ({
				ok: true,
				key,
				deleted: true,
			}),
			listValues: async () => ({
				entries: [],
				estimatedBytes: 0,
				truncated: false,
				nextStartAfter: null,
				pageSize: 50,
			}),
			exportStorage: async () => ({
				entries: [],
				estimatedBytes: 0,
				truncated: false,
				nextStartAfter: null,
				pageSize: 50,
			}),
			importStorage: async () => ({ ok: true, written: 0, cleared: false }),
			sqlQuery: async () => ({
				ok: true,
				columns: [],
				rows: [],
				rowsAffected: 0,
			}),
		}),
	}
}

export function resetJobServiceMocks() {
	vi.restoreAllMocks()
	repoMockModule.cleanupArtifactReposForSource.mockClear()
	repoMockModule.cleanupArtifactReposForSource.mockResolvedValue({
		deleted: 0,
		artifactAccessUnavailable: false,
	})
	repoMockModule.listRepoSessionsBySource.mockClear()
	repoMockModule.listRepoSessionsBySource.mockResolvedValue([])
	repoMockModule.deleteRepoSessionsBySourceForUser.mockClear()
	repoMockModule.deleteRepoSessionsBySourceForUser.mockResolvedValue(0)
	repoMockModule.cleanupSessionBranch.mockClear()
	repoMockModule.cleanupSessionBranch.mockResolvedValue({ ok: true })
	jobManagerMockModule.syncJobManagerAlarm.mockClear()
	jobManagerMockModule.getJobManagerDebugState.mockReset()
	jobManagerMockModule.getJobManagerDebugState.mockResolvedValue({
		bindingAvailable: false,
		status: 'missing_binding',
		storedUserId: null,
		alarmScheduledFor: null,
		nextRunnableJobId: null,
		nextRunnableRunAt: null,
		alarmInSync: null,
	})
	storageRunnerMockModule.clearStorage.mockClear()
	storageRunnerMockModule.clearStorage.mockResolvedValue({ ok: true })
	storageRunnerMockModule.getEstimatedBytes.mockClear()
	storageRunnerMockModule.getEstimatedBytes.mockResolvedValue({
		estimatedBytes: 0,
	})
	identityMockModule.resolveBackgroundMcpUser.mockReset()
	identityMockModule.resolveBackgroundMcpUser.mockImplementation(
		async (_db: D1Database, userId: string) => ({
			userId,
			email: `${userId}@example.com`,
			username: userId,
			displayName: userId,
		}),
	)
}

export function workerBundlerModulesMock() {
	return {
		importWorkerBundler: async () => ({
			createFileSystemSnapshot: vi.fn(
				async (files: AsyncIterable<[string, string]>) => {
					const snapshotFiles = new Map<string, string>()
					for await (const [path, content] of files) {
						snapshotFiles.set(path, content)
					}
					return {
						read(path: string) {
							return snapshotFiles.get(path) ?? null
						},
					}
				},
			),
			createWorker: vi.fn(
				async ({
					files,
					entryPoint,
				}: {
					files: Record<string, string>
					entryPoint?: string
				}) => {
					const mainModule = 'dist/bundled-entry.js'
					const selectedEntryPoint = entryPoint ?? 'index.ts'
					return {
						mainModule,
						modules: {
							[mainModule]: files[selectedEntryPoint] ?? '',
						},
						warnings: [],
					}
				},
			),
		}),
		importWorkerBundlerTypescript: async () => ({
			createTypescriptLanguageService: vi.fn(async () => ({
				fileSystem: {
					read: vi.fn(() => null),
					write: vi.fn(),
				},
				languageService: {
					getSemanticDiagnostics: vi.fn((entryPoint: string) =>
						entryPoint === '.__kody_repo_module_check__.ts' ||
						entryPoint === 'src/job.ts'
							? []
							: [{ messageText: `missing ${entryPoint}` }],
					),
				},
			})),
		}),
	}
}
