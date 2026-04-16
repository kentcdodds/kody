import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	beginAgentTurn,
	cancelAgentTurn,
	collectAgentTurnEvents,
	readNextAgentTurnEvents,
} from '#worker/agent-turn/api.ts'
import {
	agentTurnInputSchema,
	type AgentTurnResult,
	type AgentTurnStreamEvent,
	type AgentTurnToolInput,
} from '#worker/agent-turn/types.ts'

const sessionIdField = z
	.string()
	.min(1)
	.max(120)
	.describe('Stable session identifier used to scope the active agent run.')

export const metaAgentTurnStartCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'agent_turn_start',
		description:
			'Start a generic tool-using agent turn for a session and return a run id. Pair with agent_turn_next to stream events and agent_turn_cancel to interrupt the active run.',
		keywords: ['agent', 'turn', 'stream', 'start'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: agentTurnInputSchema.extend({
			sessionId: sessionIdField,
		}),
		outputSchema: z.object({
			ok: z.literal(true),
			runId: z.string(),
			sessionId: z.string(),
			conversationId: z.string(),
		}),
		async handler(args: AgentTurnToolInput, ctx: CapabilityContext) {
			const result = await beginAgentTurn({
				env: ctx.env,
				callerContext: ctx.callerContext,
				turn: args,
			})
			return {
				ok: true,
				runId: result.runId,
				sessionId: args.sessionId,
				conversationId: result.conversationId,
			} as const
		},
	},
)

export const metaAgentTurnNextCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'agent_turn_next',
		description:
			'Read the next batch of streamed events for an active agent turn run.',
		keywords: ['agent', 'turn', 'stream', 'next'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			sessionId: sessionIdField,
			runId: z.string().min(1),
			cursor: z.number().int().min(0),
			waitMs: z.number().int().min(0).max(30000).optional(),
		}),
		outputSchema: z.object({
			ok: z.literal(true),
			events: z.array(z.unknown()),
			nextCursor: z.number().int().min(0),
			done: z.boolean(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const result = await readNextAgentTurnEvents({
				env: ctx.env,
				sessionId: args.sessionId,
				runId: args.runId,
				cursor: args.cursor,
				waitMs: args.waitMs,
			})
			return {
				ok: true,
				events: result.events,
				nextCursor: result.nextCursor,
				done: result.done,
			} as const
		},
	},
)

export const metaAgentTurnCancelCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'agent_turn_cancel',
		description: 'Interrupt an active agent turn run for a session.',
		keywords: ['agent', 'turn', 'cancel', 'interrupt'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			sessionId: sessionIdField,
			runId: z.string().min(1),
		}),
		outputSchema: z.object({
			ok: z.literal(true),
			cancelled: z.boolean(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const result = await cancelAgentTurn({
				env: ctx.env,
				sessionId: args.sessionId,
				runId: args.runId,
			})
			return {
				ok: true,
				cancelled: result.cancelled,
			} as const
		},
	},
)

export const metaAgentChatTurnCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'agent_chat_turn',
		description:
			'Run a full generic tool-using agent turn to completion and return the final structured result.',
		keywords: ['agent', 'chat', 'turn', 'inference'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: agentTurnInputSchema.extend({
			sessionId: sessionIdField,
			waitMs: z
				.number()
				.int()
				.min(0)
				.max(30000)
				.optional()
				.describe('Optional long-poll wait time between event batches.'),
		}),
		outputSchema: z.object({
			ok: z.boolean(),
			result: z.unknown().optional(),
			error: z.string().optional(),
			events: z.array(z.unknown()).optional(),
		}),
		async handler(
			args: AgentTurnToolInput & { waitMs?: number },
			ctx: CapabilityContext,
		) {
			try {
				const started = await beginAgentTurn({
					env: ctx.env,
					callerContext: ctx.callerContext,
					turn: args,
				})
				const events = (await collectAgentTurnEvents({
					env: ctx.env,
					sessionId: args.sessionId,
					runId: started.runId,
					waitMs: args.waitMs,
				})) as Array<AgentTurnStreamEvent>
				const completion = events.find(
					(
						event,
					): event is Extract<
						AgentTurnStreamEvent,
						{ type: 'turn_complete' }
					> => event.type === 'turn_complete',
				)
				if (!completion) {
					return {
						ok: false,
						error: 'Agent turn finished without a turn_complete event.',
						events,
					}
				}
				const result: AgentTurnResult = {
					assistantText: completion.assistantText,
					reasoningText: completion.reasoningText,
					summary: completion.summary,
					continueRecommended: completion.continueRecommended,
					needsUserInput: completion.needsUserInput,
					stepsUsed: completion.stepsUsed,
					newInformation: completion.newInformation,
					stopReason: completion.stopReason,
					finishReason: completion.finishReason,
					toolCalls: completion.toolCalls,
					conversationId: completion.conversationId,
				}
				return {
					ok: true,
					result,
					events,
				}
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				}
			}
		},
	},
)
