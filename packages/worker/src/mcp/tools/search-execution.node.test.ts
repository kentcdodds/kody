import { expect, test, vi } from 'vitest'
import {
	createExecuteExecutor,
	runWithDynamicWorkerEvaluationBudget,
} from '#mcp/executor.ts'

const mockModule = vi.hoisted(() => {
	function createEmptySearchUnifiedResult() {
		return {
			matches: [],
			offline: false,
			intent: {
				normalizedQuery: 'skills',
				tokens: ['skills'],
				meaningfulTokens: ['skills'],
				phrases: [],
				task: { name: 'discover', confidence: 1 },
				actions: [],
				entities: [],
				constraints: [],
				confidence: 1,
			},
			telemetry: {
				intent: {
					task: 'discover',
					confidence: 1,
					entityCount: 0,
					actionCount: 0,
					constraintCount: 0,
					topEntities: [],
				},
				candidateCounts: {},
				topResultTypes: [],
			},
			phaseTimings: {
				queryUnderstandingMs: 0,
				candidateGenerationMs: 0,
				rerankingMs: 0,
			},
		}
	}
	return {
		createEmptySearchUnifiedResult,
		resolvePublicUsername: vi.fn(async () => 'user'),
		resolvePackageIdentitySearch: vi.fn(async () => ({ recognized: false })),
		loadSearchRowsAndRegistry: vi.fn(async () => ({
			packageRows: [],
			userSecretRows: [],
			userValueRows: [],
			userIntegrationRows: [],
			warnings: [],
			registry: { capabilitySpecs: {} },
		})),
		searchUnified: vi.fn(async () => createEmptySearchUnifiedResult()),
		loadRelevantMemoriesForTool: vi.fn(),
		runPackageRetrievers: vi.fn(),
	}
})

vi.mock('#worker/identity/user-lookup.ts', () => ({
	resolvePublicUsername: (...args: Array<unknown>) =>
		mockModule.resolvePublicUsername(...args),
}))

vi.mock('./package-search-identity.ts', () => ({
	resolvePackageIdentitySearch: (...args: Array<unknown>) =>
		mockModule.resolvePackageIdentitySearch(...args),
}))

vi.mock('./search-loaders.ts', () => ({
	loadSearchRowsAndRegistry: (...args: Array<unknown>) =>
		mockModule.loadSearchRowsAndRegistry(...args),
}))

vi.mock('./search-core.ts', () => ({
	buildExactPackageSearchResult: () =>
		mockModule.createEmptySearchUnifiedResult(),
	searchUnified: (...args: Array<unknown>) => mockModule.searchUnified(...args),
}))

vi.mock('#mcp/tools/memory-tool-context.ts', () => ({
	loadRelevantMemoriesForTool: (...args: Array<unknown>) =>
		mockModule.loadRelevantMemoriesForTool(...args),
	acknowledgeToolMemories: async () => undefined,
	buildMemoryRetrievalQuery: (memoryContext?: { query?: string }) =>
		memoryContext?.query?.trim() ?? '',
}))

vi.mock('#worker/package-retrievers/service.ts', () => ({
	runPackageRetrievers: (...args: Array<unknown>) =>
		mockModule.runPackageRetrievers(...args),
}))

const { executeSearchList } = await import('./search-execution.ts')

type BudgetState = {
	started: number
	active: number
	maxActive: number
	releases: Array<() => void>
}

function createBlockingLoader(state: BudgetState) {
	return {
		get(_id: string, factory: () => Record<string, unknown>) {
			factory()
			return {
				getEntrypoint() {
					return {
						async evaluate() {
							state.started += 1
							state.active += 1
							state.maxActive = Math.max(state.maxActive, state.active)
							await new Promise<void>((resolve) => {
								state.releases.push(() => {
									state.active -= 1
									resolve()
								})
							})
							return { result: 'done', logs: [] }
						},
					}
				},
			}
		},
	} as unknown as Env['LOADER']
}

function createExecutorTestExports() {
	return {
		KodyFetchGateway: ({ props }: { props: unknown }) => ({ props }),
	} as never
}

async function runThreeBlockingEvaluations(env: Env) {
	return await runWithDynamicWorkerEvaluationBudget(async () => {
		await Promise.all(
			Array.from({ length: 3 }, async (_, index) => {
				return await createExecuteExecutor({
					env,
					exports: createExecutorTestExports(),
					gatewayProps: {
						baseUrl: 'https://example.com',
						userId: 'user-1',
						storageContext: null,
					},
				}).execute(`async () => ${index}`, [{ name: 'kody', fns: {} }])
			}),
		)
	})
}

test('executeSearchList shares one dynamic-worker budget across memory and search retrievers', async () => {
	const state: BudgetState = {
		started: 0,
		active: 0,
		maxActive: 0,
		releases: [],
	}
	const env = {
		LOADER: createBlockingLoader(state),
		APP_COMMIT_SHA: 'commit-for-test',
	} as Env

	mockModule.loadRelevantMemoriesForTool.mockImplementation(async () => {
		await runThreeBlockingEvaluations(env)
		return {
			memories: [],
			retrieverResults: [],
			retrieverWarnings: [],
			suppressedCount: 0,
			retrievalQuery: 'skills',
		}
	})
	mockModule.runPackageRetrievers.mockImplementation(async () => {
		await runThreeBlockingEvaluations(env)
		return { results: [], warnings: [] }
	})

	const searchPromise = executeSearchList({
		env,
		callerContext: {
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
				username: 'user',
			},
		} as never,
		conversationId: 'conv-search-budget',
		query: 'skills',
		memoryQuery: 'skills',
		limit: 15,
		userId: 'user-1',
		includeHiddenPackages: false,
	})

	await expect.poll(() => state.started).toBe(4)
	expect(state.active).toBe(4)
	expect(state.maxActive).toBe(4)
	await new Promise((resolve) => setTimeout(resolve, 20))
	expect(state.started).toBe(4)
	expect(state.maxActive).toBe(4)

	for (const release of state.releases.splice(0)) release()
	await expect.poll(() => state.started).toBe(6)
	for (const release of state.releases.splice(0)) release()
	await searchPromise

	expect(state.started).toBe(6)
	expect(state.active).toBe(0)
	expect(state.maxActive).toBe(4)
	expect(mockModule.loadRelevantMemoriesForTool).toHaveBeenCalledTimes(1)
	expect(mockModule.runPackageRetrievers).toHaveBeenCalledTimes(1)
})
