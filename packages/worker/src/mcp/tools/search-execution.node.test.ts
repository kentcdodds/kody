import { expect, test, vi } from 'vitest'
import {
	createExecuteExecutor,
	runWithDynamicWorkerEvaluationBudget,
} from '#mcp/executor.ts'
import {
	CAPABILITY_EMBEDDING_DIMENSIONS,
	deterministicEmbedding,
} from '#worker/vectorize/embedding.ts'

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

test('executeSearchList embeds each distinct text once and starts the query embedding before rows resolve', async () => {
	const embedTexts: Array<string> = []
	let releaseRows: () => void = () => {}
	const rowsGate = new Promise<void>((resolve) => {
		releaseRows = resolve
	})
	mockModule.loadSearchRowsAndRegistry.mockImplementation(async () => {
		await rowsGate
		return {
			packageRows: [],
			userSecretRows: [],
			userValueRows: [],
			userIntegrationRows: [],
			warnings: [],
			registry: { capabilitySpecs: {} },
		}
	})
	mockModule.loadRelevantMemoriesForTool.mockImplementation(
		async (input: { embedText?: (text: string) => Promise<Array<number>> }) => {
			await input.embedText?.('skills')
			return {
				memories: [],
				retrieverResults: [],
				retrieverWarnings: [],
				suppressedCount: 0,
				retrievalQuery: 'skills',
			}
		},
	)
	mockModule.searchUnified.mockImplementation(
		async (input: { embedText?: (text: string) => Promise<Array<number>> }) => {
			await input.embedText?.('skills')
			return mockModule.createEmptySearchUnifiedResult()
		},
	)
	mockModule.runPackageRetrievers.mockResolvedValue({
		results: [],
		warnings: [],
	})

	const env = {
		SENTRY_ENVIRONMENT: 'production',
		AI: {
			async run(...args: Array<unknown>) {
				const input = args[1] as { text?: unknown }
				const batch = Array.isArray(input.text)
					? input.text.map(String)
					: [String(input.text ?? '')]
				embedTexts.push(...batch)
				return {
					data: batch.map((text) => deterministicEmbedding(text)),
					shape: [batch.length, CAPABILITY_EMBEDDING_DIMENSIONS],
				}
			},
		},
		CAPABILITY_VECTOR_INDEX: {
			async query() {
				return { matches: [] }
			},
		},
		APP_DB: {},
	} as unknown as Env

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
		conversationId: 'conv-embed-once',
		query: 'skills',
		memoryQuery: 'skills',
		limit: 15,
		userId: 'user-1',
		includeHiddenPackages: false,
	})

	await expect.poll(() => embedTexts).toEqual(['skills'])
	releaseRows()
	await searchPromise
	expect(embedTexts).toEqual(['skills'])

	embedTexts.length = 0
	mockModule.loadSearchRowsAndRegistry.mockImplementation(async () => ({
		packageRows: [],
		userSecretRows: [],
		userValueRows: [],
		userIntegrationRows: [],
		warnings: [],
		registry: { capabilitySpecs: {} },
	}))
	mockModule.loadRelevantMemoriesForTool.mockImplementation(
		async (input: {
			embedText?: (text: string) => Promise<Array<number>>
			memoryContext?: { query?: string }
		}) => {
			await input.embedText?.(input.memoryContext?.query ?? 'draft an email')
			return {
				memories: [],
				retrieverResults: [],
				retrieverWarnings: [],
				suppressedCount: 0,
				retrievalQuery: 'draft an email',
			}
		},
	)

	await executeSearchList({
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
		conversationId: 'conv-embed-distinct',
		query: 'skills',
		memoryContext: { query: 'draft an email' },
		limit: 15,
		userId: 'user-1',
		includeHiddenPackages: false,
	})

	expect([...embedTexts].sort()).toEqual(['draft an email', 'skills'])
})

function emptySearchRows() {
	return {
		packageRows: [],
		userSecretRows: [],
		userValueRows: [],
		userIntegrationRows: [],
		warnings: [],
		registry: { capabilitySpecs: {} },
	}
}

function signedInSearchCaller() {
	return {
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'User',
			username: 'user',
		},
	} as never
}

test('executeSearchList does not leak an unhandled rejection when the ranking embedding fails during row load', async () => {
	const unhandled: Array<unknown> = []
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason)
	}
	process.on('unhandledRejection', onUnhandled)
	try {
		let releaseRows = () => {}
		const rowsGate = new Promise<void>((resolve) => {
			releaseRows = resolve
		})
		let resolveEmbedStarted = () => {}
		const embedStarted = new Promise<void>((resolve) => {
			resolveEmbedStarted = resolve
		})
		const embeddingError = new Error('Workers AI unavailable')
		mockModule.loadSearchRowsAndRegistry.mockImplementation(async () => {
			await rowsGate
			return emptySearchRows()
		})
		mockModule.loadRelevantMemoriesForTool.mockResolvedValue({
			memories: [],
			retrieverResults: [],
			retrieverWarnings: [],
			suppressedCount: 0,
			retrievalQuery: 'skills',
		})
		mockModule.searchUnified.mockImplementation(
			async (input: {
				embedText?: (text: string) => Promise<Array<number>>
				query: string
			}) => {
				await input.embedText?.(input.query)
				return mockModule.createEmptySearchUnifiedResult()
			},
		)
		mockModule.runPackageRetrievers.mockResolvedValue({
			results: [],
			warnings: [],
		})

		const env = {
			SENTRY_ENVIRONMENT: 'production',
			AI: {
				async run() {
					resolveEmbedStarted()
					throw embeddingError
				},
			},
			CAPABILITY_VECTOR_INDEX: {
				async query() {
					return { matches: [] }
				},
			},
			APP_DB: {},
		} as unknown as Env

		const searchPromise = executeSearchList({
			env,
			callerContext: signedInSearchCaller(),
			conversationId: 'conv-embed-reject',
			query: 'skills',
			memoryQuery: 'skills',
			limit: 15,
			userId: 'user-1',
			includeHiddenPackages: false,
		})

		await embedStarted
		await Promise.resolve()
		await Promise.resolve()
		expect(unhandled).toEqual([])
		releaseRows()
		await expect(searchPromise).rejects.toThrow('Workers AI unavailable')
		await Promise.resolve()
		await Promise.resolve()
		expect(unhandled).toEqual([])
	} finally {
		process.off('unhandledRejection', onUnhandled)
	}
})

test('executeSearchList does not prefetch an embedding for domain-overview or index queries', async () => {
	let aiRunCount = 0
	mockModule.loadSearchRowsAndRegistry.mockResolvedValue(emptySearchRows())
	mockModule.loadRelevantMemoriesForTool.mockResolvedValue({
		memories: [],
		retrieverResults: [],
		retrieverWarnings: [],
		suppressedCount: 0,
		retrievalQuery: 'what can kody do',
	})
	mockModule.searchUnified.mockImplementation(async () =>
		mockModule.createEmptySearchUnifiedResult(),
	)
	mockModule.runPackageRetrievers.mockResolvedValue({
		results: [],
		warnings: [],
	})

	const env = {
		SENTRY_ENVIRONMENT: 'production',
		AI: {
			async run() {
				aiRunCount += 1
				throw new Error('Workers AI should not run for overview search')
			},
		},
		CAPABILITY_VECTOR_INDEX: {
			async query() {
				return { matches: [] }
			},
		},
		APP_DB: {},
	} as unknown as Env

	await executeSearchList({
		env,
		callerContext: signedInSearchCaller(),
		conversationId: 'conv-embed-overview',
		query: 'what can kody do',
		limit: 15,
		userId: 'user-1',
		includeHiddenPackages: false,
	})
	expect(aiRunCount).toBe(0)

	await executeSearchList({
		env,
		callerContext: signedInSearchCaller(),
		conversationId: 'conv-embed-index',
		query: '',
		limit: 15,
		userId: 'user-1',
		includeHiddenPackages: false,
	})
	expect(aiRunCount).toBe(0)
})
