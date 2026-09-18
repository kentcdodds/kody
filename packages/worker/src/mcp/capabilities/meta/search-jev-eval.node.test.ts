import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	executeSearchList: vi.fn(),
}))

vi.mock('#mcp/tools/search-execution.ts', () => ({
	executeSearchList: (...args: Array<unknown>) =>
		mockModule.executeSearchList(...args),
}))

const { searchCapability } = await import('./search.ts')

function createContext(input: { roles?: Array<string> }) {
	return {
		env: {} as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
				username: 'kentcdodds',
				roles: input.roles ?? ['user'],
				permissions: [],
			},
			storageContext: null,
			repoContext: null,
		},
	}
}

function rankedExecution(jevEnabled: boolean) {
	return {
		result: {
			matches: [
				{
					type: 'capability',
					name: 'search',
					description: 'Search',
					domain: 'meta',
				},
			],
			offline: false,
			intent: {
				normalizedQuery: 'email',
				tokens: ['email'],
				meaningfulTokens: ['email'],
				phrases: ['email'],
				task: { name: 'inspect' as const, confidence: 0.9 },
				actions: [],
				entities: [],
				constraints: [],
				confidence: 0.9,
			},
			telemetry: {
				intent: {
					task: 'inspect',
					confidence: 0.9,
					entityCount: 0,
					actionCount: 0,
					constraintCount: 0,
					topEntities: [],
				},
				candidateCounts: { capability: 1 },
				topResultTypes: ['capability'],
				jevRerank: {
					enabled: jevEnabled,
					outcome: jevEnabled ? 'applied' : 'skipped-flag-off',
					candidatesBefore: jevEnabled ? 40 : 15,
					candidatesAfter: 5,
					droppedCount: jevEnabled ? 10 : 0,
					meanConfidence: jevEnabled ? 0.8 : null,
					top1Type: 'capability',
				},
			},
			phaseTimings: {
				queryUnderstandingMs: 1,
				candidateGenerationMs: 2,
				rerankingMs: 3,
				jevRerankMs: jevEnabled ? 12 : 0.1,
			},
			guidance: 'Inspect capability detail.',
		},
		username: 'kentcdodds',
		warnings: [],
		memorySettlement: { warnings: [], phaseTimings: {} },
		phaseTimings: {},
		capabilityGuidance: 'Inspect capability detail.',
	}
}

test('meta search exposes Jev eval telemetry for admins even when flag is off', async () => {
	mockModule.executeSearchList.mockResolvedValueOnce(rankedExecution(false))
	const result = await searchCapability.handler(
		{ query: 'email', conversationId: 'meta-jev-admin' },
		createContext({ roles: ['admin', 'user'] }),
	)
	expect(result.telemetry?.jevRerank).toEqual({
		enabled: false,
		outcome: 'skipped-flag-off',
		candidatesBefore: 15,
		candidatesAfter: 5,
		droppedCount: 0,
		meanConfidence: null,
		top1Type: 'capability',
		jevRerankMs: 0.1,
	})
})

test('meta search exposes Jev eval telemetry when flag cohort is on', async () => {
	mockModule.executeSearchList.mockResolvedValueOnce(rankedExecution(true))
	const result = await searchCapability.handler(
		{ query: 'email', conversationId: 'meta-jev-flag-on' },
		createContext({ roles: ['user'] }),
	)
	expect(result.telemetry?.jevRerank).toMatchObject({
		enabled: true,
		outcome: 'applied',
		candidatesBefore: 40,
		jevRerankMs: 12,
	})
})

test('meta search omits Jev eval telemetry for non-admin flag-off callers', async () => {
	mockModule.executeSearchList.mockResolvedValueOnce(rankedExecution(false))
	const result = await searchCapability.handler(
		{ query: 'email', conversationId: 'meta-jev-hidden' },
		createContext({ roles: ['user'] }),
	)
	expect(result.telemetry).toBeUndefined()
})
