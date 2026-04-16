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
}

type PersistedState = {
	activeRun: ActiveRunState | null
}

const persistedStateKey = 'agent-turn-runner-state'

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

class AgentTurnRunnerBase extends DurableObject<Env> {
	private stateSnapshot: PersistedState = {
		activeRun: null,
	}

	private waiters = new Set<() => void>()

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
	}

	private async persistState() {
		await this.ctx.storage.put(persistedStateKey, this.stateSnapshot)
	}

	private notifyWaiters() {
		for (const waiter of this.waiters) waiter()
		this.waiters.clear()
	}

	private async handleStart(body: StartRequestBody) {
		const runId = crypto.randomUUID()
		const conversationId = resolveConversationId(body.turn.conversationId)
		const run: ActiveRunState = {
			runId,
			createdAt: new Date().toISOString(),
			cancelled: false,
			events: [],
			done: false,
			finalResult: null,
		}
		this.stateSnapshot.activeRun = run
		await this.persistState()

		void this.executeRun({
			runId,
			callerContext: body.callerContext,
			turn: {
				...body.turn,
				conversationId,
			},
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

		const { events, completion } = await runAgentTurn({
			env: this.env,
			callerContext: input.callerContext,
			turn: input.turn,
			abortSignal: abortController.signal,
		})

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
			} catch (error) {
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
			}
		})()

		await consume
	}

	private async waitForChange(waitMs: number) {
		if (waitMs <= 0) return
		await Promise.race([
			new Promise<void>((resolve) => {
				this.waiters.add(resolve)
			}),
			scheduler.wait(waitMs),
		])
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
		await this.persistState()
		this.notifyWaiters()
		return Response.json({ ok: true, cancelled: true })
	}
}

export const AgentTurnRunner = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	AgentTurnRunnerBase,
)
