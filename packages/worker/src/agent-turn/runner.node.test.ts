import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => {
	const streamText = vi.fn()
	const stepCountIs = vi.fn((count: number) => ({
		type: 'step-count-is',
		count,
	}))
	const createWorkersAI = vi.fn(() =>
		vi.fn(() => ({ provider: 'workers-ai-model' })),
	)
	const createAgentTurnToolSet = vi.fn(async () => ({}))

	return {
		streamText,
		stepCountIs,
		createWorkersAI,
		createAgentTurnToolSet,
	}
})

vi.mock('ai', () => ({
	streamText: (...args: Array<unknown>) => mockModule.streamText(...args),
	stepCountIs: (...args: Array<unknown>) => mockModule.stepCountIs(...args),
}))

vi.mock('workers-ai-provider', () => ({
	createWorkersAI: (...args: Array<unknown>) =>
		mockModule.createWorkersAI(...args),
}))

vi.mock('./tools.ts', () => ({
	createAgentTurnToolSet: (...args: Array<unknown>) =>
		mockModule.createAgentTurnToolSet(...args),
}))

const { runAgentTurn } = await import('./runner.ts')

test('runAgentTurn emits deltas and a final structured result', async () => {
	mockModule.streamText.mockImplementationOnce(
		(options: Record<string, unknown>) => {
			return {
				async consumeStream() {
					await (options.onChunk as Function)?.({
						chunk: { type: 'reasoning-delta', text: 'thinking...' },
					})
					await (options.onChunk as Function)?.({
						chunk: { type: 'text-delta', text: 'Hello' },
					})
					await (options.onChunk as Function)?.({
						chunk: {
							type: 'tool-call',
							toolCallId: 'call-1',
							toolName: 'search',
							input: { query: 'hello' },
						},
					})
					await (options.onChunk as Function)?.({
						chunk: {
							type: 'tool-result',
							toolCallId: 'call-1',
							toolName: 'search',
							output: { result: 'world' },
						},
					})
					await (options.onStepFinish as Function)?.({
						stepNumber: 0,
						finishReason: 'stop',
					})
					await (options.onFinish as Function)?.({
						steps: [{ toolCalls: [], toolResults: [] }],
						finishReason: 'stop',
					})
				},
				text: Promise.resolve('Hello'),
				reasoningText: Promise.resolve('thinking...'),
			}
		},
	)

	const turn = await runAgentTurn({
		env: { AI: {}, AI_GATEWAY_ID: 'gateway-id' } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-123' },
			homeConnectorId: null,
			remoteConnectors: null,
			storageContext: null,
		},
		turn: {
			system: 'system',
			messages: [{ role: 'user', content: 'hello' }],
			sessionId: 'session-1',
		},
	})

	const events = []
	for await (const event of turn.events) {
		events.push(event)
	}

	const completion = await turn.completion

	expect(events).toEqual(
		expect.arrayContaining([
			{ type: 'reasoning_delta', text: 'thinking...' },
			{ type: 'assistant_delta', text: 'Hello' },
			{
				type: 'tool_call_started',
				id: 'call-1',
				toolName: 'search',
				input: { query: 'hello' },
			},
			{
				type: 'tool_call_finished',
				id: 'call-1',
				toolName: 'search',
				input: { query: 'hello' },
				output: { result: 'world' },
			},
		]),
	)
	expect(completion.assistantText).toBe('Hello')
	expect(completion.reasoningText).toBe('thinking...')
	expect(completion.stepsUsed).toBe(1)
	expect(completion.stopReason).toBe('completed')
	expect(completion.conversationId).toBeTruthy()
})

test('runAgentTurn marks no_new_information for repeated tool calls', async () => {
	mockModule.streamText.mockImplementationOnce(
		(options: Record<string, unknown>) => {
			return {
				async consumeStream() {
					for (const id of ['call-1', 'call-2']) {
						await (options.onChunk as Function)?.({
							chunk: {
								type: 'tool-call',
								toolCallId: id,
								toolName: 'search',
								input: { query: 'same' },
							},
						})
						await (options.onChunk as Function)?.({
							chunk: {
								type: 'tool-result',
								toolCallId: id,
								toolName: 'search',
								output: { result: 'same' },
							},
						})
					}
					await (options.onStepFinish as Function)?.({
						stepNumber: 1,
						finishReason: 'tool-calls',
					})
					await (options.onFinish as Function)?.({
						steps: [{}, {}],
						finishReason: 'tool-calls',
					})
				},
				text: Promise.resolve('Need more work'),
				reasoningText: Promise.resolve(''),
			}
		},
	)

	const turn = await runAgentTurn({
		env: { AI: {}, AI_GATEWAY_ID: 'gateway-id' } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-123' },
			homeConnectorId: null,
			remoteConnectors: null,
			storageContext: null,
		},
		turn: {
			system: 'system',
			messages: [{ role: 'user', content: 'hello' }],
			sessionId: 'session-2',
		},
	})

	await turn.events[Symbol.asyncIterator]()
		.next()
		.catch(() => {})
	const completion = await turn.completion
	expect(completion.newInformation).toBe(false)
	expect(completion.stopReason).toBe('no_new_information')
	expect(completion.continueRecommended).toBe(false)
})

test('runAgentTurn forwards cache-aware system and message hints to the AI runtime', async () => {
	mockModule.streamText.mockImplementationOnce(
		(options: Record<string, unknown>) => {
			return {
				async consumeStream() {
					await (options.onFinish as Function)?.({
						steps: [],
						finishReason: 'stop',
					})
				},
				text: Promise.resolve('done'),
				reasoningText: Promise.resolve(''),
			}
		},
	)

	const turn = await runAgentTurn({
		env: {
			AI: {},
			AI_GATEWAY_ID: 'gateway-id',
			AI_MODEL: 'anthropic/claude-sonnet-4.5',
		} as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-123' },
			homeConnectorId: null,
			remoteConnectors: null,
			storageContext: null,
		},
		turn: {
			system: {
				content: 'stable system',
				cache: 'prefix',
			},
			messages: [
				{
					role: 'user',
					content: 'normalized thread context',
					cache: 'prefix',
				},
				{
					role: 'user',
					content: 'latest inbound email',
				},
			],
			sessionId: 'session-3',
		},
	})

	await turn.completion

	expect(mockModule.streamText).toHaveBeenLastCalledWith({
		model: { provider: 'workers-ai-model' },
		messages: [
			{
				role: 'system',
				content: 'stable system',
				providerOptions: {
					anthropic: { cacheControl: { type: 'ephemeral' } },
				},
			},
			{
				role: 'user',
				content: 'normalized thread context',
				providerOptions: {
					anthropic: { cacheControl: { type: 'ephemeral' } },
				},
			},
			{
				role: 'user',
				content: 'latest inbound email',
			},
		],
		tools: {},
		abortSignal: undefined,
		onFinish: expect.any(Function),
		onChunk: expect.any(Function),
		onAbort: expect.any(Function),
		onStepFinish: expect.any(Function),
		stopWhen: { type: 'step-count-is', count: 8 },
	})
})
