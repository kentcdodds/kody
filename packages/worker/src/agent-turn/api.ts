import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	cancelAgentTurnRun,
	nextAgentTurnRunEvent,
	startAgentTurnRun,
} from './service.ts'
import { type AgentTurnToolInput, type AgentTurnStreamEvent } from './types.ts'

export async function beginAgentTurn(input: {
	env: Env
	callerContext: McpCallerContext
	turn: AgentTurnToolInput
}) {
	return startAgentTurnRun({
		env: input.env,
		sessionId: input.turn.sessionId,
		callerContext: input.callerContext,
		turn: input.turn,
	})
}

export async function collectAgentTurnEvents(input: {
	env: Env
	sessionId: string
	runId: string
	waitMs?: number
}) {
	let cursor = 0
	const allEvents: Array<AgentTurnStreamEvent> = []
	let done = false
	while (!done) {
		const next = await nextAgentTurnRunEvent({
			env: input.env,
			sessionId: input.sessionId,
			runId: input.runId,
			cursor,
			waitMs: input.waitMs,
		})
		cursor = next.nextCursor
		allEvents.push(...(next.events as Array<AgentTurnStreamEvent>))
		done = next.done
	}
	return allEvents
}

export async function readNextAgentTurnEvents(input: {
	env: Env
	sessionId: string
	runId: string
	cursor: number
	waitMs?: number
}) {
	const next = await nextAgentTurnRunEvent(input)
	return {
		events: next.events as Array<AgentTurnStreamEvent>,
		nextCursor: next.nextCursor,
		done: next.done,
	}
}

export async function cancelAgentTurn(input: {
	env: Env
	sessionId: string
	runId: string
}) {
	return cancelAgentTurnRun(input)
}
