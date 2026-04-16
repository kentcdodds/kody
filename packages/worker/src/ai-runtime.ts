import {
	convertToModelMessages,
	type ModelMessage,
	stepCountIs,
	streamText,
	type StreamTextOnChunkCallback,
	type StreamTextOnFinishCallback,
	type StreamTextOnStepFinishCallback,
	type StreamTextResult,
	type ToolSet,
	type UIMessage,
} from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { getRemoteAiLocalDevCredentialsError } from '@kody-internal/shared/ai-env-validation.ts'
import { type AiMode } from '@kody-internal/shared/chat.ts'
import {
	buildMockAiScenario,
	type MockAiResponse,
} from '@kody-internal/shared/mock-ai.ts'

const defaultModel = '@cf/zai-org/glm-4.7-flash'
const remoteToolLoopMaxSteps = 5

export type StreamChatReplyInput = {
	messages: Array<UIMessage>
	system: string
	tools: ToolSet
	toolNames: Array<string>
	abortSignal?: AbortSignal
	onFinish?: StreamTextOnFinishCallback<ToolSet>
}

export type AiRuntimeResult =
	| { kind: 'response'; response: Response }
	| MockAiResponse

export type AiRuntime = {
	streamChatReply(input: StreamChatReplyInput): Promise<AiRuntimeResult>
}

export type StreamToolLoopInput = {
	messages: Array<UIMessage> | Array<ModelMessage>
	system: string
	tools: ToolSet
	toolNames?: Array<string>
	abortSignal?: AbortSignal
	onFinish?: StreamTextOnFinishCallback<ToolSet>
	onChunk?: StreamTextOnChunkCallback<ToolSet>
	onAbort?: (event: {
		reason?: string
		steps: Array<unknown>
	}) => PromiseLike<void> | void
	onStepFinish?: StreamTextOnStepFinishCallback<ToolSet>
	maxSteps?: number
}

type AIEnabledEnv = Env & {
	AI: Ai
}

type WorkersAiCredentialsEnv = Env & {
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	WRANGLER_IS_LOCAL_DEV?: string
}

function resolveAiMode(env: Env): AiMode {
	if (env.AI_MODE) return env.AI_MODE
	return 'mock'
}

function createWorkersAiProvider(env: WorkersAiCredentialsEnv) {
	const gatewayId = env.AI_GATEWAY_ID?.trim()
	if (!gatewayId) {
		throw new Error(
			'AI_GATEWAY_ID is required when AI_MODE is "remote". Configure it in local env or GitHub Actions secrets.',
		)
	}
	const gateway = { gateway: { id: gatewayId } }
	const isLocalDev = env.WRANGLER_IS_LOCAL_DEV === 'true'
	if (isLocalDev) {
		const credentialsError = getRemoteAiLocalDevCredentialsError(env)
		if (credentialsError) {
			throw new Error(credentialsError)
		}
		return createWorkersAI({
			accountId: env.CLOUDFLARE_ACCOUNT_ID!.trim(),
			apiKey: env.CLOUDFLARE_API_TOKEN!.trim(),
			...gateway,
		})
	}

	return createWorkersAI({
		binding: (env as AIEnabledEnv).AI,
		...gateway,
	})
}

function isUiMessageArray(
	messages: Array<UIMessage> | Array<ModelMessage>,
): messages is Array<UIMessage> {
	return messages.some((message) => 'parts' in message)
}

async function toModelMessages(
	messages: Array<UIMessage> | Array<ModelMessage>,
): Promise<Array<ModelMessage>> {
	if (isUiMessageArray(messages)) {
		return (await convertToModelMessages(messages)) as Array<ModelMessage>
	}
	return messages as Array<ModelMessage>
}

export async function streamRemoteToolLoop(
	env: WorkersAiCredentialsEnv,
	input: StreamToolLoopInput,
): Promise<StreamTextResult<ToolSet, never>> {
	const workersai = createWorkersAiProvider(env)
	return streamText({
		model: workersai(env.AI_MODEL ?? defaultModel),
		system: input.system,
		messages: await toModelMessages(input.messages),
		tools: input.tools,
		stopWhen: stepCountIs(input.maxSteps ?? remoteToolLoopMaxSteps),
		abortSignal: input.abortSignal,
		onFinish: input.onFinish,
		onChunk: input.onChunk,
		onAbort: input.onAbort,
		onStepFinish: input.onStepFinish,
	})
}

function createRemoteAiRuntime(env: WorkersAiCredentialsEnv): AiRuntime {
	return {
		async streamChatReply(input) {
			const result = await streamRemoteToolLoop(env, input)

			return {
				kind: 'response',
				response: result.toUIMessageStreamResponse(),
			}
		},
	}
}

function createMockAiRuntime(env: Env): AiRuntime {
	const baseUrl = env.AI_MOCK_BASE_URL?.trim()

	return {
		async streamChatReply(input) {
			if (!baseUrl) {
				const userMessages = input.messages.filter(
					(message) => message.role === 'user',
				)
				const latestUserMessage = userMessages.at(-1)
				const lastUserMessage =
					latestUserMessage?.parts
						.filter(
							(
								part,
							): part is Extract<
								(typeof latestUserMessage.parts)[number],
								{ type: 'text' }
							> => part.type === 'text',
						)
						.map((part) => part.text)
						.join('\n')
						.trim() ?? ''
				return buildMockAiScenario({
					lastUserMessage,
					toolNames: input.toolNames,
				}).response
			}

			const url = new URL('/chat', baseUrl)
			const response = await fetch(url.toString(), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(env.AI_MOCK_API_KEY
						? {
								Authorization: `Bearer ${env.AI_MOCK_API_KEY}`,
							}
						: {}),
				},
				body: JSON.stringify({
					system: input.system,
					messages: input.messages,
					toolNames: input.toolNames,
				}),
				signal: input.abortSignal,
			})

			if (!response.ok) {
				const body = await response.text().catch(() => '')
				throw new Error(
					`Mock AI worker failed (${response.status} ${response.statusText}): ${body}`,
				)
			}

			return (await response.json()) as MockAiResponse
		},
	}
}

export function createAiRuntime(env: Env): AiRuntime {
	const mode = resolveAiMode(env)
	if (mode === 'remote') return createRemoteAiRuntime(env as AIEnabledEnv)
	return createMockAiRuntime(env)
}
