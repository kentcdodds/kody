import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type AgentTurnInput,
	type AgentTurnResult,
	type AgentTurnStreamEvent,
} from './types.ts'
import { resolveConversationId } from '#mcp/tools/tool-call-context.ts'
import { runAgentTurn } from './runner.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'

type ActiveRunState = {
	runId: string
	createdAt: string
	cancelled: boolean
	events: Array<AgentTurnStreamEvent>
	done: boolean
	finalResult: AgentTurnResult | null
	input: StartRequestBody
}

type PersistedState = {
	activeRun: ActiveRunState | null
}

const persistedStateKey = 'agent-turn-runner-state'
const interruptedOnRestoreMessage =
	'Agent turn was interrupted when the Durable Object restarted. Start a new run to continue.'

type StartRequestBody = {
	callerContext: McpCallerContext
	turn: AgentTurnInput
}

type NextRequestBody = {
	runId: string
	cursor: number
	waitMs: number
}

type CancelRequestBody = {
	runId: string
}

function markRunInterruptedOnRestore(run: ActiveRunState): ActiveRunState {
	return {
		...run,
		done: true,
		finalResult: null,
		events: [
			...run.events,
			{
				type: 'error',
				message: interruptedOnRestoreMessage,
				phase: 'restore',
			},
		],
	}
}

export class AgentTurnRunnerBase extends DurableObject<Env> {
	private stateSnapshot: PersistedState = {
		activeRun: null,
	}

	private waiters = new Set<() => void>()
	private activeAbortController: AbortController | null = null

	constructor(state: DurableObjectState, env: Env) {
		super(state, env)
		state.blockConcurrencyWhile(async () => {
			await this.restoreState()
		})
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (request.method === 'POST' && url.pathname === '/start') {
			const body = (await request.json()) as StartRequestBody
			return this.handleStart(body)
		}
		if (request.method === 'POST' && url.pathname === '/next') {
			const body = (await request.json()) as NextRequestBody
			return this.handleNext(body)
		}
		if (request.method === 'POST' && url.pathname === '/cancel') {
			const body = (await request.json()) as CancelRequestBody
			return this.handleCancel(body)
		}
		return Response.json({ ok: false, error: 'Not found.' }, { status: 404 })
	}

	private async restoreState() {
		const persisted =
			(await this.ctx.storage.get<PersistedState>(persistedStateKey)) ?? null
		if (persisted) this.stateSnapshot = persisted
		if (this.stateSnapshot.activeRun && !this.stateSnapshot.activeRun.done) {
			// A restarted DO cannot safely resume in-flight model/tool work without
			// risking duplicate external side effects, so fail closed instead.
			this.stateSnapshot.activeRun = markRunInterruptedOnRestore(
				this.stateSnapshot.activeRun,
			)
			await this.persistState()
		}
	}

	private async persistState() {
		await this.ctx.storage.put(persistedStateKey, this.stateSnapshot)
	}

	private notifyWaiters() {
		for (const waiter of this.waiters) waiter()
		this.waiters.clear()
	}

	private async handleStart(body: StartRequestBody) {
		const existingRun = this.stateSnapshot.activeRun
		if (existingRun && !existingRun.done && !existingRun.cancelled) {
			return Response.json(
				{
					ok: false,
					error: 'An agent turn is already active for this session.',
				},
				{ status: 409 },
			)
		}
		const runId = crypto.randomUUID()
		const conversationId = resolveConversationId(body.turn.conversationId)
		const run: ActiveRunState = {
			runId,
			createdAt: new Date().toISOString(),
			cancelled: false,
			events: [],
			done: false,
			finalResult: null,
			input: {
				callerContext: body.callerContext,
				turn: {
					...body.turn,
					conversationId,
				},
			},
		}
		this.stateSnapshot.activeRun = run
		await this.persistState()

		void this.executeRun({
			runId,
			callerContext: run.input.callerContext,
			turn: run.input.turn,
		})

		return Response.json({
			ok: true,
			runId,
			conversationId,
		})
	}

	private async executeRun(input: {
		runId: string
		callerContext: McpCallerContext
		turn: AgentTurnInput
	}) {
		const run = this.stateSnapshot.activeRun
		if (!run || run.runId !== input.runId) return

		const abortController = new AbortController()
		this.activeAbortController = abortController

		const recordRunError = async (error: unknown) => {
			const currentRun = this.stateSnapshot.activeRun
			if (!currentRun || currentRun.runId !== input.runId) return
			currentRun.events.push({
				type: 'error',
				message: error instanceof Error ? error.message : String(error),
				phase: 'runner',
			})
			currentRun.done = true
			await this.persistState()
			this.notifyWaiters()
			if (this.activeAbortController === abortController) {
				this.activeAbortController = null
			}
		}

		let events: Awaited<ReturnType<typeof runAgentTurn>>['events']
		let completion: Awaited<ReturnType<typeof runAgentTurn>>['completion']
		try {
			;({ events, completion } = await runAgentTurn({
				env: this.env,
				callerContext: input.callerContext,
				turn: input.turn,
				abortSignal: abortController.signal,
			}))
		} catch (error) {
			await recordRunError(error)
			return
		}

		const consume = (async () => {
			try {
				for await (const event of events) {
					const currentRun = this.stateSnapshot.activeRun
					if (!currentRun || currentRun.runId !== input.runId) return
					if (currentRun.cancelled) {
						abortController.abort('cancelled')
						return
					}
					currentRun.events.push(event)
					await this.persistState()
					this.notifyWaiters()
				}

				const finalResult = await completion
				const currentRun = this.stateSnapshot.activeRun
				if (!currentRun || currentRun.runId !== input.runId) return
				currentRun.finalResult = finalResult
				currentRun.done = true
				await this.persistState()
				this.notifyWaiters()
				if (this.activeAbortController === abortController) {
					this.activeAbortController = null
				}
			} catch (error) {
				await recordRunError(error)
			}
		})()

		await consume
	}

	private async waitForChange(waitMs: number) {
		if (waitMs <= 0) return
		let resolver: (() => void) | null = null
		await Promise.race([
			new Promise<void>((resolve) => {
				resolver = resolve
				this.waiters.add(resolve)
			}),
			scheduler.wait(waitMs),
		])
		if (resolver) this.waiters.delete(resolver)
	}

	private async handleNext(body: NextRequestBody) {
		let run = this.stateSnapshot.activeRun
		if (!run || run.runId !== body.runId) {
			return Response.json({
				ok: true,
				events: [],
				nextCursor: body.cursor,
				done: true,
			})
		}

		if (body.cursor >= run.events.length && !run.done) {
			await this.waitForChange(body.waitMs)
			run = this.stateSnapshot.activeRun
		}

		if (!run || run.runId !== body.runId) {
			return Response.json({
				ok: true,
				events: [],
				nextCursor: body.cursor,
				done: true,
			})
		}

		const events = run.events.slice(body.cursor)
		return Response.json({
			ok: true,
			events,
			nextCursor: body.cursor + events.length,
			done: run.done,
		})
	}

	private async handleCancel(body: CancelRequestBody) {
		const run = this.stateSnapshot.activeRun
		if (!run || run.runId !== body.runId) {
			return Response.json({ ok: true, cancelled: false })
		}
		run.cancelled = true
		run.done = true
		this.activeAbortController?.abort('cancelled')
		await this.persistState()
		this.notifyWaiters()
		return Response.json({ ok: true, cancelled: true })
	}
}

export const AgentTurnRunner = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	AgentTurnRunnerBase,
)
