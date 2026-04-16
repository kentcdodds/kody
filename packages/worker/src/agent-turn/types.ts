import { z } from 'zod'
import {
	conversationIdInputField,
	memoryContextInputField,
} from '#mcp/tools/tool-call-context.ts'

export const agentTurnMessageSchema = z.object({
	role: z.enum(['system', 'user', 'assistant']),
	content: z.string().min(1),
})

export const agentTurnInputSchema = z.object({
	messages: z.array(agentTurnMessageSchema).min(1),
	system: z.string().min(1).describe('System prompt to use for this turn.'),
	sessionId: z
		.string()
		.min(1)
		.max(120)
		.optional()
		.describe(
			'Optional stable session identifier used to scope interruption and active-run semantics.',
		),
	maxSteps: z
		.number()
		.int()
		.min(1)
		.max(25)
		.optional()
		.describe('Maximum tool-calling steps to allow in this turn.'),
	conversationId: conversationIdInputField,
	memoryContext: memoryContextInputField,
})

export const agentTurnToolInputSchema = agentTurnInputSchema.extend({
	sessionId: z
		.string()
		.min(1)
		.max(120)
		.describe('Stable session identifier used to scope the active agent run.'),
})

export type AgentTurnMessage = z.infer<typeof agentTurnMessageSchema>
export type AgentTurnInput = z.infer<typeof agentTurnInputSchema>
export type AgentTurnToolInput = z.infer<typeof agentTurnToolInputSchema>

export type AgentToolTrace = {
	id: string
	toolName: string
	input: unknown
	output?: unknown
	error?: string
}

export type AgentTurnStopReason =
	| 'completed'
	| 'needs_user'
	| 'continue_recommended'
	| 'budget_exhausted'
	| 'no_new_information'
	| 'tool_error'
	| 'interrupted'

export type AgentTurnResult = {
	assistantText: string
	reasoningText: string
	summary: string | null
	continueRecommended: boolean
	needsUserInput: boolean
	stepsUsed: number
	newInformation: boolean
	stopReason: AgentTurnStopReason
	finishReason: string
	toolCalls: Array<AgentToolTrace>
	conversationId: string
}

export type AgentTurnStreamEvent =
	| { type: 'assistant_delta'; text: string }
	| { type: 'reasoning_delta'; text: string }
	| { type: 'tool_call_started'; id: string; toolName: string; input: unknown }
	| {
			type: 'tool_call_finished'
			id: string
			toolName: string
			input: unknown
			output?: unknown
			error?: string
	  }
	| { type: 'error'; message: string; phase: string }
	| ({ type: 'turn_complete' } & AgentTurnResult)
