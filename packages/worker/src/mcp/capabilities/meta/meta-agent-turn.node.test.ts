import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	beginAgentTurn: vi.fn(),
	readNextAgentTurnEvents: vi.fn(),
	collectAgentTurnEvents: vi.fn(),
	cancelAgentTurn: vi.fn(),
}))

vi.mock('#worker/agent-turn/api.ts', () => ({
	beginAgentTurn: (...args: Array<unknown>) =>
		mockModule.beginAgentTurn(...args),
	readNextAgentTurnEvents: (...args: Array<unknown>) =>
		mockModule.readNextAgentTurnEvents(...args),
	collectAgentTurnEvents: (...args: Array<unknown>) =>
		mockModule.collectAgentTurnEvents(...args),
	cancelAgentTurn: (...args: Array<unknown>) =>
		mockModule.cancelAgentTurn(...args),
}))

const {
	metaAgentChatTurnCapability,
	metaAgentTurnCancelCapability,
	metaAgentTurnNextCapability,
	metaAgentTurnStartCapability,
} = await import('./meta-agent-turn.ts')

const ctx = {
	env: {} as Env,
	callerContext: {
		baseUrl: 'https://heykody.dev',
		user: { userId: 'user-123' },
		homeConnectorId: null,
		remoteConnectors: null,
		storageContext: null,
	},
} as const

test('agent_turn_start delegates to the runner service', async () => {
	mockModule.beginAgentTurn.mockResolvedValueOnce({
		ok: true,
		runId: 'run-123',
		conversationId: 'conversation-123',
	})

	const result = await metaAgentTurnStartCapability.handler(
		{
			sessionId: 'session-123',
			system: 'system',
			messages: [{ role: 'user', content: 'hello' }],
		},
		ctx as never,
	)

	expect(result).toEqual({
		ok: true,
		runId: 'run-123',
		sessionId: 'session-123',
		conversationId: 'conversation-123',
	})
})

test('agent_turn_next returns incremental events', async () => {
	mockModule.readNextAgentTurnEvents.mockResolvedValueOnce({
		events: [{ type: 'assistant_delta', text: 'Hi' }],
		nextCursor: 1,
		done: false,
	})

	const result = await metaAgentTurnNextCapability.handler(
		{
			sessionId: 'session-123',
			runId: 'run-123',
			cursor: 0,
		},
		ctx as never,
	)

	expect(result).toEqual({
		ok: true,
		events: [{ type: 'assistant_delta', text: 'Hi' }],
		nextCursor: 1,
		done: false,
	})
})

test('agent_turn_cancel forwards cancellation', async () => {
	mockModule.cancelAgentTurn.mockResolvedValueOnce({
		ok: true,
		cancelled: true,
	})

	const result = await metaAgentTurnCancelCapability.handler(
		{
			sessionId: 'session-123',
			runId: 'run-123',
		},
		ctx as never,
	)

	expect(result).toEqual({
		ok: true,
		cancelled: true,
	})
})

test('agent_chat_turn collects events and returns final structured result', async () => {
	mockModule.beginAgentTurn.mockResolvedValueOnce({
		ok: true,
		runId: 'run-123',
		conversationId: 'conversation-123',
	})
	mockModule.collectAgentTurnEvents.mockResolvedValueOnce([
		{ type: 'assistant_delta', text: 'Hi' },
		{
			type: 'turn_complete',
			assistantText: 'Hello world',
			reasoningText: 'thinking',
			summary: null,
			continueRecommended: false,
			needsUserInput: false,
			stepsUsed: 1,
			newInformation: true,
			stopReason: 'completed',
			finishReason: 'stop',
			toolCalls: [],
			conversationId: 'conversation-123',
		},
	])

	const result = await metaAgentChatTurnCapability.handler(
		{
			sessionId: 'session-123',
			system: 'system',
			messages: [{ role: 'user', content: 'hello' }],
		},
		ctx as never,
	)

	expect(result).toEqual({
		ok: true,
		result: {
			assistantText: 'Hello world',
			reasoningText: 'thinking',
			summary: null,
			continueRecommended: false,
			needsUserInput: false,
			stepsUsed: 1,
			newInformation: true,
			stopReason: 'completed',
			finishReason: 'stop',
			toolCalls: [],
			conversationId: 'conversation-123',
		},
		events: [
			{ type: 'assistant_delta', text: 'Hi' },
			{
				type: 'turn_complete',
				assistantText: 'Hello world',
				reasoningText: 'thinking',
				summary: null,
				continueRecommended: false,
				needsUserInput: false,
				stepsUsed: 1,
				newInformation: true,
				stopReason: 'completed',
				finishReason: 'stop',
				toolCalls: [],
				conversationId: 'conversation-123',
			},
		],
	})
})
