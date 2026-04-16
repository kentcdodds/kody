import { expect, test, vi } from 'vitest'

const persistedStateKey = 'agent-turn-runner-state'
const interruptedOnRestoreMessage =
	'Agent turn was interrupted when the Durable Object restarted. Start a new run to continue.'

const mockModule = vi.hoisted(() => ({
	runAgentTurn: vi.fn(),
}))

vi.mock('@sentry/cloudflare', () => ({
	instrumentDurableObjectWithSentry: (
		_getOptions: unknown,
		durableObjectClass: unknown,
	) => durableObjectClass,
}))

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		protected readonly ctx: DurableObjectState
		protected readonly env: Env

		constructor(ctx: DurableObjectState, env: Env) {
			this.ctx = ctx
			this.env = env
		}
	},
}))

vi.mock('./runner.ts', () => ({
	runAgentTurn: (...args: Array<unknown>) => mockModule.runAgentTurn(...args),
}))

const { AgentTurnRunnerBase } = await import('./runner-do.ts')

function createCallerContext() {
	return {
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
		homeConnectorId: null,
		remoteConnectors: null,
		storageContext: null,
	}
}

function createState(persistedState: unknown) {
	const persistedEntries = new Map<string, unknown>([
		[persistedStateKey, structuredClone(persistedState)],
	])
	let blocked = Promise.resolve()
	const state = {
		storage: {
			get: vi.fn(async (key: string) =>
				structuredClone(persistedEntries.get(key)),
			),
			put: vi.fn(async (key: string, value: unknown) => {
				persistedEntries.set(key, structuredClone(value))
			}),
		},
		blockConcurrencyWhile: vi.fn((callback: () => Promise<unknown>) => {
			blocked = Promise.resolve().then(callback)
			return blocked
		}),
	}
	return {
		state: state as unknown as DurableObjectState,
		persistedEntries,
		async waitUntilReady() {
			await blocked
		},
	}
}

test('restored in-progress runs are finalized as interrupted instead of replayed', async () => {
	const persistedState = {
		activeRun: {
			runId: 'run-123',
			createdAt: '2026-04-16T00:00:00.000Z',
			cancelled: false,
			events: [{ type: 'assistant_delta', text: 'partial output' }],
			done: false,
			finalResult: null,
			input: {
				callerContext: createCallerContext(),
				turn: {
					sessionId: 'session-123',
					conversationId: 'conversation-123',
					system: 'system',
					messages: [{ role: 'user', content: 'hello' }],
				},
			},
		},
	}
	const { state, persistedEntries, waitUntilReady } =
		createState(persistedState)

	const runner = new AgentTurnRunnerBase(state, {} as Env)
	await waitUntilReady()

	expect(mockModule.runAgentTurn).not.toHaveBeenCalled()

	const response = await runner.fetch(
		new Request('https://agent-turn.internal/next', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				runId: 'run-123',
				cursor: 0,
				waitMs: 0,
			}),
		}),
	)

	expect(await response.json()).toEqual({
		ok: true,
		events: [
			{ type: 'assistant_delta', text: 'partial output' },
			{
				type: 'error',
				message: interruptedOnRestoreMessage,
				phase: 'restore',
			},
		],
		nextCursor: 2,
		done: true,
	})

	expect(persistedEntries.get(persistedStateKey)).toEqual({
		activeRun: {
			runId: 'run-123',
			createdAt: '2026-04-16T00:00:00.000Z',
			cancelled: false,
			events: [
				{ type: 'assistant_delta', text: 'partial output' },
				{
					type: 'error',
					message: interruptedOnRestoreMessage,
					phase: 'restore',
				},
			],
			done: true,
			finalResult: null,
			input: {
				callerContext: createCallerContext(),
				turn: {
					sessionId: 'session-123',
					conversationId: 'conversation-123',
					system: 'system',
					messages: [{ role: 'user', content: 'hello' }],
				},
			},
		},
	})
})

test('executeRun suppresses completion rejection when cancellation returns early', async () => {
	const { state, waitUntilReady } = createState({ activeRun: null })
	const runner = new AgentTurnRunnerBase(state, {} as Env)
	await waitUntilReady()

	const callerContext = createCallerContext()
	const turn = {
		sessionId: 'session-123',
		conversationId: 'conversation-123',
		system: 'system',
		messages: [{ role: 'user', content: 'hello' }],
	}
	let rejectCompletion: ((error: unknown) => void) | null = null
	const completion = new Promise<never>((_resolve, reject) => {
		rejectCompletion = reject
	})
	const completionWithSpy = completion as Promise<never> & {
		catch: typeof completion.catch
	}
	const originalCatch = completionWithSpy.catch.bind(completionWithSpy)
	let catchCalls = 0
	completionWithSpy.catch = ((onRejected) => {
		catchCalls += 1
		return originalCatch(onRejected)
	}) as typeof completion.catch

	mockModule.runAgentTurn.mockResolvedValueOnce({
		conversationId: 'conversation-123',
		events: (async function* () {
			yield { type: 'assistant_delta', text: 'partial output' } as const
		})(),
		completion: completionWithSpy,
	})

	;(
		runner as unknown as { stateSnapshot: { activeRun: unknown } }
	).stateSnapshot = {
		activeRun: {
			runId: 'run-123',
			createdAt: '2026-04-16T00:00:00.000Z',
			cancelled: true,
			events: [],
			done: false,
			finalResult: null,
			input: {
				callerContext,
				turn,
			},
		},
	}

	await (
		runner as unknown as {
			executeRun(input: {
				runId: string
				callerContext: ReturnType<typeof createCallerContext>
				turn: typeof turn
			}): Promise<void>
		}
	).executeRun({
		runId: 'run-123',
		callerContext,
		turn,
	})

	expect(catchCalls).toBe(1)
	expect(
		(runner as unknown as { activeAbortController: AbortController | null })
			.activeAbortController,
	).toBe(null)

	rejectCompletion?.(new Error('cancelled'))
	await Promise.resolve()
})
