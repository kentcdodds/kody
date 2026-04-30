import { expect, test, vi } from 'vitest'
import { agentTurnInputSchema } from '#worker/agent-turn/types.ts'

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

test('agent turn capabilities delegate across start, next, and cancel flows', async () => {
	mockModule.beginAgentTurn.mockResolvedValueOnce({
		ok: true,
		runId: 'run-123',
		conversationId: 'conversation-123',
	})
	mockModule.readNextAgentTurnEvents.mockResolvedValueOnce({
		events: [{ type: 'assistant_delta', text: 'Hi' }],
		nextCursor: 1,
		done: false,
	})
	mockModule.cancelAgentTurn.mockResolvedValueOnce({
		ok: true,
		cancelled: true,
	})

	const startResult = await metaAgentTurnStartCapability.handler(
		{
			sessionId: 'session-123',
			system: 'system',
			messages: [{ role: 'user', content: 'hello' }],
		},
		ctx as never,
	)
	expect(startResult).toEqual({
		ok: true,
		runId: 'run-123',
		sessionId: 'session-123',
		conversationId: 'conversation-123',
	})

	const nextResult = await metaAgentTurnNextCapability.handler(
		{
			sessionId: 'session-123',
			runId: 'run-123',
			cursor: 0,
		},
		ctx as never,
	)
	expect(nextResult).toEqual({
		ok: true,
		events: [{ type: 'assistant_delta', text: 'Hi' }],
		nextCursor: 1,
		done: false,
	})

	const cancelResult = await metaAgentTurnCancelCapability.handler(
		{
			sessionId: 'session-123',
			runId: 'run-123',
		},
		ctx as never,
	)
	expect(cancelResult).toEqual({
		ok: true,
		cancelled: true,
	})
})

test('agent turn schema accepts cache-aware prompts while preserving string compatibility', () => {
	expect(
		agentTurnInputSchema.parse({
			sessionId: 'session-123',
			system: 'plain system prompt',
			messages: [{ role: 'user', content: 'latest email only' }],
		}),
	).toEqual({
		sessionId: 'session-123',
		system: 'plain system prompt',
		messages: [{ role: 'user', content: 'latest email only' }],
	})

	expect(
		agentTurnInputSchema.parse({
			sessionId: 'session-456',
			system: {
				content: 'stable system prompt',
				cache: 'prefix',
			},
			messages: [
				{
					role: 'user',
					content: 'normalized prior thread context',
					cache: 'prefix',
				},
				{
					role: 'user',
					content: 'latest inbound email',
				},
			],
		}),
	).toEqual({
		sessionId: 'session-456',
		system: {
			content: 'stable system prompt',
			cache: 'prefix',
		},
		messages: [
			{
				role: 'user',
				content: 'normalized prior thread context',
				cache: 'prefix',
			},
			{
				role: 'user',
				content: 'latest inbound email',
			},
		],
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
			system: {
				content: 'stable system',
				cache: 'prefix',
			},
			messages: [
				{ role: 'user', content: 'thread context', cache: 'prefix' },
				{ role: 'user', content: 'hello' },
			],
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
	expect(mockModule.beginAgentTurn).toHaveBeenLastCalledWith({
		env: ctx.env,
		callerContext: ctx.callerContext,
		turn: {
			sessionId: 'session-123',
			system: {
				content: 'stable system',
				cache: 'prefix',
			},
			messages: [
				{ role: 'user', content: 'thread context', cache: 'prefix' },
				{ role: 'user', content: 'hello' },
			],
		},
	})
})
