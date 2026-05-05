import { resolveConversationId } from '#mcp/tools/tool-call-context.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	streamRemoteToolLoop,
	type CacheAwareModelMessage,
	type CacheAwareSystemPrompt,
} from '#worker/ai-runtime.ts'
import {
	agentTurnInputSchema,
	type AgentToolTrace,
	type AgentTurnInput,
	type AgentTurnMessage,
	type AgentTurnResult,
	type AgentTurnStopReason,
	type AgentTurnStreamEvent,
	type AgentTurnSystemPrompt,
} from './types.ts'
import { createAgentTurnToolSet } from './tools.ts'

const defaultMaxSteps = 8

type QueueEntry<T> =
	| { type: 'value'; value: T }
	| { type: 'error'; error: unknown }
	| { type: 'done' }

class AsyncEventQueue<T> implements AsyncIterable<T> {
	private readonly values: Array<QueueEntry<T>> = []
	private readonly waiters: Array<(entry: QueueEntry<T>) => void> = []

	push(value: T) {
		this.enqueue({ type: 'value', value })
	}

	error(error: unknown) {
		this.enqueue({ type: 'error', error })
	}

	done() {
		this.enqueue({ type: 'done' })
	}

	private enqueue(entry: QueueEntry<T>) {
		const waiter = this.waiters.shift()
		if (waiter) {
			waiter(entry)
			return
		}
		this.values.push(entry)
	}

	private async nextEntry(): Promise<QueueEntry<T>> {
		if (this.values.length > 0) {
			return this.values.shift() as QueueEntry<T>
		}
		return new Promise((resolve) => {
			this.waiters.push(resolve)
		})
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			const entry = await this.nextEntry()
			if (entry.type === 'value') {
				yield entry.value
				continue
			}
			if (entry.type === 'error') {
				throw entry.error
			}
			return
		}
	}
}

function clean(value: unknown) {
	return String(value ?? '').trim()
}

function toSystemPrompt(system: AgentTurnSystemPrompt): CacheAwareSystemPrompt {
	if (typeof system === 'string') {
		return system
	}
	return {
		content: system.content,
		...(system.cache ? { cache: system.cache } : {}),
	}
}

function toModelMessages(
	messages: Array<AgentTurnMessage>,
): Array<CacheAwareModelMessage> {
	return messages.map((message) => ({
		role: message.role,
		content: message.content,
		...(message.cache ? { cache: message.cache } : {}),
	}))
}

function stringifyToolPayload(value: unknown) {
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function fingerprint(value: unknown) {
	const text = stringifyToolPayload(value)
	let hash = 2166136261
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 16777619)
	}
	return hash >>> 0
}

function hasNewInformation(toolCalls: Array<AgentToolTrace>) {
	if (toolCalls.length < 2) return true
	const last = toolCalls[toolCalls.length - 1]
	const previous = toolCalls[toolCalls.length - 2]
	if (!last || !previous) return true
	if (last.toolName !== previous.toolName) return true
	if (fingerprint(last.input) !== fingerprint(previous.input)) return true
	if (
		fingerprint(last.output ?? last.error ?? null) !==
		fingerprint(previous.output ?? previous.error ?? null)
	) {
		return true
	}
	return false
}

function inferNeedsUserInput(input: {
	assistantText: string
	finishReason: string
}) {
	const text = input.assistantText.toLowerCase()
	return (
		text.includes('?') &&
		(text.includes('could you') ||
			text.includes('can you clarify') ||
			text.includes('what do you mean') ||
			text.includes('which part'))
	)
}

function inferContinueRecommended(input: {
	finishReason: string
	stepsUsed: number
	needsUserInput: boolean
	newInformation: boolean
	maxSteps: number
}) {
	if (input.needsUserInput) return false
	if (!input.newInformation) return false
	if (input.finishReason === 'tool-calls') return true
	return input.stepsUsed >= input.maxSteps
}

function inferStopReason(input: {
	continueRecommended: boolean
	needsUserInput: boolean
	newInformation: boolean
	stepsUsed: number
	maxSteps: number
	finishReason: string
}) {
	if (input.needsUserInput) return 'needs_user' satisfies AgentTurnStopReason
	if (!input.newInformation)
		return 'no_new_information' satisfies AgentTurnStopReason
	if (input.continueRecommended) {
		return input.stepsUsed >= input.maxSteps
			? ('budget_exhausted' satisfies AgentTurnStopReason)
			: ('continue_recommended' satisfies AgentTurnStopReason)
	}
	return 'completed' satisfies AgentTurnStopReason
}

export async function runAgentTurn(input: {
	env: Env
	callerContext: McpCallerContext
	turn: AgentTurnInput
	abortSignal?: AbortSignal
}) {
	const parsed = agentTurnInputSchema.parse(input.turn)
	const conversationId = resolveConversationId(parsed.conversationId)
	const systemPrompt = toSystemPrompt(parsed.system)
	const modelMessages = toModelMessages(parsed.messages)
	const tools = await createAgentTurnToolSet({
		env: input.env,
		callerContext: input.callerContext,
		conversationId,
		memoryContext: parsed.memoryContext,
	})
	const queue = new AsyncEventQueue<AgentTurnStreamEvent>()
	const toolCalls: Array<AgentToolTrace> = []
	let assistantText = ''
	let reasoningText = ''
	let finishReason = 'stop'
	let stepsUsed = 0

	const result = await streamRemoteToolLoop(input.env, {
		system: systemPrompt,
		messages: modelMessages,
		tools,
		maxSteps: parsed.maxSteps ?? defaultMaxSteps,
		abortSignal: input.abortSignal,
		onChunk: async ({ chunk }) => {
			if (chunk.type === 'text-delta') {
				assistantText += chunk.text
				queue.push({ type: 'assistant_delta', text: chunk.text })
			}
			if (chunk.type === 'reasoning-delta') {
				reasoningText += chunk.text
				queue.push({ type: 'reasoning_delta', text: chunk.text })
			}
			if (chunk.type === 'tool-call') {
				const trace: AgentToolTrace = {
					id: chunk.toolCallId,
					toolName: chunk.toolName,
					input: chunk.input,
				}
				toolCalls.push(trace)
				queue.push({
					type: 'tool_call_started',
					id: chunk.toolCallId,
					toolName: chunk.toolName,
					input: chunk.input,
				})
			}
			if (chunk.type === 'tool-result') {
				const trace = toolCalls.find((entry) => entry.id === chunk.toolCallId)
				if (trace) {
					trace.output = chunk.output
				}
				queue.push({
					type: 'tool_call_finished',
					id: chunk.toolCallId,
					toolName: chunk.toolName,
					input: trace?.input ?? null,
					output: chunk.output,
				})
			}
		},
		onStepFinish: async (event) => {
			stepsUsed = event.stepNumber + 1
			finishReason = event.finishReason
		},
		onFinish: async (event) => {
			stepsUsed = event.steps.length
			finishReason = event.finishReason
		},
		onAbort: async () => {
			queue.push({
				type: 'error',
				message: 'Turn aborted.',
				phase: 'abort',
			})
		},
	})

	const completion = (async () => {
		try {
			await result.consumeStream()
			const text = clean(await result.text)
			const reasoning = clean(await result.reasoningText)
			const lastToolCalls = toolCalls.map((entry) => ({ ...entry }))
			const newInformation = hasNewInformation(lastToolCalls)
			const needsUserInput = inferNeedsUserInput({
				assistantText: text,
				finishReason,
			})
			const continueRecommended = inferContinueRecommended({
				finishReason,
				stepsUsed,
				needsUserInput,
				newInformation,
				maxSteps: parsed.maxSteps ?? defaultMaxSteps,
			})
			const stopReason = inferStopReason({
				continueRecommended,
				needsUserInput,
				newInformation,
				stepsUsed,
				maxSteps: parsed.maxSteps ?? defaultMaxSteps,
				finishReason,
			})
			const finalResult: AgentTurnResult = {
				assistantText: text,
				reasoningText: reasoning,
				summary: null,
				continueRecommended,
				needsUserInput,
				stepsUsed,
				newInformation,
				stopReason,
				finishReason,
				toolCalls: lastToolCalls,
				conversationId,
			}
			queue.push({
				type: 'turn_complete',
				...finalResult,
			})
			queue.done()
			return finalResult
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			queue.push({ type: 'error', message, phase: 'run' })
			queue.error(error)
			throw error
		}
	})()

	return {
		conversationId,
		events: queue,
		completion,
	}
}
