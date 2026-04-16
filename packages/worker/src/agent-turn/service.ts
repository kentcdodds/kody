import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { agentTurnInputSchema, type AgentTurnInput } from './types.ts'

const agentTurnRunnerOrigin = 'https://agent-turn.internal'
const defaultPollWaitMs = 5_000

type AgentTurnRunnerBinding = DurableObjectNamespace

type AgentTurnRunStartResult = {
	ok: true
	runId: string
	conversationId: string
}

type AgentTurnRunNextResult = {
	ok: true
	events: Array<unknown>
	nextCursor: number
	done: boolean
}

type AgentTurnRunCancelResult = {
	ok: true
	cancelled: boolean
}

function getRunnerNamespace(env: Env): AgentTurnRunnerBinding {
	const namespace = (
		env as Env & { AGENT_TURN_RUNNER?: AgentTurnRunnerBinding }
	).AGENT_TURN_RUNNER
	if (!namespace) {
		throw new Error('AGENT_TURN_RUNNER binding is not configured.')
	}
	return namespace
}

function getRunnerStub(env: Env, sessionId: string) {
	const namespace = getRunnerNamespace(env)
	return namespace.get(namespace.idFromName(sessionId))
}

async function readJsonResponse<T>(response: Response): Promise<T> {
	const body = await response.json().catch(() => null)
	if (!response.ok || body == null) {
		throw new Error(
			`Agent turn runner request failed with HTTP ${response.status}.`,
		)
	}
	return body as T
}

export async function startAgentTurnRun(input: {
	env: Env
	sessionId: string
	callerContext: McpCallerContext
	turn: AgentTurnInput
}) {
	const parsedTurn = agentTurnInputSchema.parse(input.turn)
	const stub = getRunnerStub(input.env, input.sessionId)
	const response = await stub.fetch(
		new Request(`${agentTurnRunnerOrigin}/start`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				callerContext: input.callerContext,
				turn: parsedTurn,
			}),
		}),
	)
	return readJsonResponse<AgentTurnRunStartResult>(response)
}

export async function nextAgentTurnRunEvent(input: {
	env: Env
	sessionId: string
	runId: string
	cursor: number
	waitMs?: number
}) {
	const stub = getRunnerStub(input.env, input.sessionId)
	const response = await stub.fetch(
		new Request(`${agentTurnRunnerOrigin}/next`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				runId: input.runId,
				cursor: input.cursor,
				waitMs: input.waitMs ?? defaultPollWaitMs,
			}),
		}),
	)
	return readJsonResponse<AgentTurnRunNextResult>(response)
}

export async function cancelAgentTurnRun(input: {
	env: Env
	sessionId: string
	runId: string
}) {
	const stub = getRunnerStub(input.env, input.sessionId)
	const response = await stub.fetch(
		new Request(`${agentTurnRunnerOrigin}/cancel`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				runId: input.runId,
			}),
		}),
	)
	return readJsonResponse<AgentTurnRunCancelResult>(response)
}
