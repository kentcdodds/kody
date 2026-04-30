import { buildMockAiScenario } from '@kody-internal/shared/mock-ai.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => {
	const toUIMessageStreamResponse = vi.fn(() => new Response('ok'))
	const streamText = vi.fn(() => ({
		toUIMessageStreamResponse,
	}))
	const convertToModelMessages = vi.fn(async (messages) => messages)
	const stepCountIs = vi.fn((count: number) => ({
		type: 'step-count-is',
		count,
	}))
	const model = vi.fn(() => ({ provider: 'workers-ai-model' }))
	const createWorkersAI = vi.fn(() => model)

	return {
		toUIMessageStreamResponse,
		streamText,
		convertToModelMessages,
		stepCountIs,
		model,
		createWorkersAI,
	}
})

vi.mock('ai', () => ({
	convertToModelMessages: (...args: Array<unknown>) =>
		mockModule.convertToModelMessages(...args),
	stepCountIs: (...args: Array<unknown>) => mockModule.stepCountIs(...args),
	streamText: (...args: Array<unknown>) => mockModule.streamText(...args),
}))

vi.mock('workers-ai-provider', () => ({
	createWorkersAI: (...args: Array<unknown>) =>
		mockModule.createWorkersAI(...args),
}))

const { createAiRuntime, streamRemoteToolLoop } = await import('./ai-runtime.ts')

test('remote ai runtime sets a multi-step stop condition for tool continuation', async () => {
	const runtime = createAiRuntime({
		AI_MODE: 'remote',
		AI_GATEWAY_ID: 'gateway-id',
		AI: {} as Ai,
	} as Env)
	const onFinish = vi.fn()
	const abortController = new AbortController()
	const messages = [
		{
			id: 'message-1',
			role: 'user',
			parts: [{ type: 'text', text: 'use a tool and continue' }],
		},
	] as const

	const result = await runtime.streamChatReply({
		messages: [...messages],
		system: 'system prompt',
		tools: {} as never,
		toolNames: [],
		abortSignal: abortController.signal,
		onFinish,
	})

	expect(result).toEqual({
		kind: 'response',
		response: expect.any(Response),
	})
	expect(mockModule.createWorkersAI).toHaveBeenCalledWith({
		binding: {},
		gateway: { id: 'gateway-id' },
	})
	expect(mockModule.model).toHaveBeenCalledWith('@cf/zai-org/glm-4.7-flash')
	expect(mockModule.stepCountIs).toHaveBeenCalledWith(5)
	expect(mockModule.streamText).toHaveBeenCalledWith({
		model: { provider: 'workers-ai-model' },
		system: 'system prompt',
		messages: [...messages],
		tools: {},
		abortSignal: abortController.signal,
		onFinish,
		stopWhen: { type: 'step-count-is', count: 5 },
	})
	expect(mockModule.toUIMessageStreamResponse).toHaveBeenCalledTimes(1)
})

test('remote tool loop promotes cached system and message prefixes for Anthropic models', async () => {
	mockModule.streamText.mockClear()
	mockModule.model.mockClear()

	await streamRemoteToolLoop(
		{
			AI_MODE: 'remote',
			AI_GATEWAY_ID: 'gateway-id',
			AI_MODEL: 'anthropic/claude-sonnet-4.5',
			AI: {} as Ai,
		} as Env,
		{
			system: {
				content: 'stable system prompt',
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
			tools: {} as never,
			maxSteps: 3,
		},
	)

	expect(mockModule.model).toHaveBeenCalledWith('anthropic/claude-sonnet-4.5')
	expect(mockModule.streamText).toHaveBeenCalledWith({
		model: { provider: 'workers-ai-model' },
		messages: [
			{
				role: 'system',
				content: 'stable system prompt',
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
		stopWhen: { type: 'step-count-is', count: 3 },
	})
})

test('remote tool loop keeps cache hints inert for unsupported models', async () => {
	mockModule.streamText.mockClear()
	mockModule.model.mockClear()

	await streamRemoteToolLoop(
		{
			AI_MODE: 'remote',
			AI_GATEWAY_ID: 'gateway-id',
			AI_MODEL: '@cf/zai-org/glm-4.7-flash',
			AI: {} as Ai,
		} as Env,
		{
			system: {
				content: 'stable system prompt',
				cache: 'prefix',
			},
			messages: [
				{
					role: 'user',
					content: 'normalized thread context',
					cache: 'prefix',
				},
			],
			tools: {} as never,
		},
	)

	expect(mockModule.model).toHaveBeenCalledWith('@cf/zai-org/glm-4.7-flash')
	expect(mockModule.streamText).toHaveBeenCalledWith({
		model: { provider: 'workers-ai-model' },
		system: 'stable system prompt',
		messages: [
			{
				role: 'user',
				content: 'normalized thread context',
			},
		],
		tools: {},
		stopWhen: { type: 'step-count-is', count: 5 },
	})
})

test('mock ai runtime still returns a local fallback response', async () => {
	const runtime = createAiRuntime({ AI_MODE: 'mock' } as Env)
	const toolNames = ['search', 'open_generated_ui']

	const result = await runtime.streamChatReply({
		messages: [
			{
				id: 'message-1',
				role: 'user',
				parts: [{ type: 'text', text: 'help' }],
			},
		] as never,
		system: 'system prompt',
		tools: {} as never,
		toolNames,
	})

	expect(result).toEqual(
		buildMockAiScenario({
			lastUserMessage: 'help',
			toolNames,
		}).response,
	)
})

test('remote ai runtime keeps the local-dev credential error', async () => {
	const runtime = createAiRuntime({
		AI_MODE: 'remote',
		AI_GATEWAY_ID: 'gateway-id',
		WRANGLER_IS_LOCAL_DEV: 'true',
		CLOUDFLARE_ACCOUNT_ID: '',
		CLOUDFLARE_API_TOKEN: '',
	} as Env)

	await expect(
		runtime.streamChatReply({
			messages: [] as never,
			system: 'system prompt',
			tools: {} as never,
			toolNames: [],
		}),
	).rejects.toThrow(
		'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required when AI_MODE is "remote" in local dev. Add them to packages/worker/.env before starting `npm run dev`.',
	)
})
