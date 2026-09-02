import { AsyncLocalStorage } from 'node:async_hooks'
import { executorSandboxTimeoutMessage } from '#worker/sentry-options.ts'

/**
 * Cloudflare caps Worker Loader evaluations at four for one incoming request.
 * Async-local state shares that budget with nested evaluations while keeping
 * unrelated requests out of the same queue.
 */
export const maxConcurrentDynamicWorkerEvaluationsPerRequest = 4

export const dynamicWorkerCapacityErrorMessages = [
	'Too many concurrent dynamic workers',
	'Dynamic worker concurrency limit exceeded: each request may have up to 4 concurrent dynamic worker invocations.',
] as const

type DynamicWorkerPermitWaiter = {
	resolve: () => void
	reject: (error: Error) => void
}

type DynamicWorkerEvaluationGate = {
	active: number
	queue: Array<DynamicWorkerPermitWaiter>
}

export type DynamicWorkerEvaluationContext = {
	gate: DynamicWorkerEvaluationGate
	depth: number
}

const dynamicWorkerEvaluationGateStorage =
	new AsyncLocalStorage<DynamicWorkerEvaluationContext>()

export function getDynamicWorkerEvaluationContext() {
	return dynamicWorkerEvaluationGateStorage.getStore()
}

export function isDynamicWorkerCapacityErrorMessage(message: string) {
	return dynamicWorkerCapacityErrorMessages.some((candidate) =>
		message.includes(candidate),
	)
}

/**
 * Open the per-request Worker Loader budget if the caller is not already
 * inside one. Nested callers inherit the same gate so sibling evaluations
 * share Cloudflare's four-slot cap.
 */
export async function runWithDynamicWorkerEvaluationBudget<T>(
	callback: () => Promise<T>,
): Promise<T> {
	const inheritedContext = dynamicWorkerEvaluationGateStorage.getStore()
	if (inheritedContext) {
		return await callback()
	}
	const requestContext: DynamicWorkerEvaluationContext = {
		gate: {
			active: 0,
			queue: [],
		},
		depth: 0,
	}
	return await dynamicWorkerEvaluationGateStorage.run(requestContext, callback)
}

/**
 * Run work against the current request gate as a queueable root (depth 0).
 * Fire-and-forget subscription handlers must use this so extras wait for a
 * free slot instead of fail-fast (depth > 0) or opening a second gate.
 */
export async function runQueueableDynamicWorkerWork<T>(
	callback: () => Promise<T>,
): Promise<T> {
	const inheritedContext = dynamicWorkerEvaluationGateStorage.getStore()
	if (!inheritedContext) {
		return await runWithDynamicWorkerEvaluationBudget(callback)
	}
	if (inheritedContext.depth === 0) {
		return await callback()
	}
	return await dynamicWorkerEvaluationGateStorage.run(
		{
			gate: inheritedContext.gate,
			depth: 0,
		},
		callback,
	)
}

/**
 * Re-enter a gate captured when host dispatchers were created. Sandbox → host
 * capability RPC often loses AsyncLocalStorage; without this, each refresh
 * opens an isolated 4-slot budget and Cloudflare rejects the extras.
 */
export async function runWithCapturedDynamicWorkerEvaluationContext<T>(
	context: DynamicWorkerEvaluationContext | undefined,
	callback: () => Promise<T>,
): Promise<T> {
	if (!context) {
		return await callback()
	}
	return await dynamicWorkerEvaluationGateStorage.run(context, callback)
}

function throwIfEvaluationDeadlineAborted(signal?: AbortSignal) {
	if (!signal?.aborted) return
	const reason = signal.reason
	if (reason instanceof Error) throw reason
	throw new Error(executorSandboxTimeoutMessage)
}

/**
 * Acquire one of the four Worker Loader slots, queueing at depth 0 and
 * failing fast at nested depth so a saturated ancestor cannot deadlock.
 */
export async function withDynamicWorkerEvaluationPermit<T>(
	evaluate: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return await runWithDynamicWorkerEvaluationBudget(async () => {
		const context = dynamicWorkerEvaluationGateStorage.getStore()
		if (!context) {
			throw new Error('Dynamic worker evaluation budget was not initialized.')
		}
		return await runWithDynamicWorkerEvaluationPermit(context, evaluate, signal)
	})
}

async function runWithDynamicWorkerEvaluationPermit<T>(
	context: DynamicWorkerEvaluationContext,
	evaluate: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const { gate } = context
	throwIfEvaluationDeadlineAborted(signal)
	let acquired = false
	if (gate.active < maxConcurrentDynamicWorkerEvaluationsPerRequest) {
		gate.active += 1
		acquired = true
	} else if (context.depth > 0) {
		// A nested evaluation cannot wait safely once the request is saturated:
		// every active permit may belong to an ancestor/sibling that is itself
		// awaiting a descendant. Only independent roots in an explicit request
		// budget (depth 0) may queue because another root can finish without
		// waiting for the queued evaluation.
		throw new Error(dynamicWorkerCapacityErrorMessages[1])
	} else {
		await new Promise<void>((resolve, reject) => {
			const waiter: DynamicWorkerPermitWaiter = {
				resolve: () => {
					cleanup()
					resolve()
				},
				reject: (error) => {
					cleanup()
					reject(error)
				},
			}
			const onAbort = () => {
				const index = gate.queue.indexOf(waiter)
				if (index >= 0) {
					gate.queue.splice(index, 1)
				}
				waiter.reject(
					signal?.reason instanceof Error
						? signal.reason
						: new Error(executorSandboxTimeoutMessage),
				)
			}
			const cleanup = () => {
				if (signal) {
					signal.removeEventListener('abort', onAbort)
				}
			}
			if (signal) {
				signal.addEventListener('abort', onAbort, { once: true })
				if (signal.aborted) {
					onAbort()
					return
				}
			}
			gate.queue.push(waiter)
		})
		acquired = true
	}
	try {
		throwIfEvaluationDeadlineAborted(signal)
		return await dynamicWorkerEvaluationGateStorage.run(
			{
				gate,
				depth: context.depth + 1,
			},
			evaluate,
		)
	} finally {
		if (acquired) {
			const next = gate.queue.shift()
			if (next) {
				next.resolve()
			} else {
				gate.active -= 1
			}
		}
	}
}
