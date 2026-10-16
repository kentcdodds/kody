/**
 * Hosted MCP clients stop waiting on tools/call after about 60s and surface
 * JSON-RPC -32001 ("Request timed out"). Progress notifications do not reset
 * that clock. Return a follow handle before the client gives up.
 */
export const hostedExecuteTransportBudgetMs = 45_000

const defaultExecuteIdempotencyKeyPrefix = 'execute:'

/** Server-assigned retry token when the caller did not pass one. */
export function createDefaultExecuteIdempotencyKey() {
	return `${defaultExecuteIdempotencyKeyPrefix}${crypto.randomUUID()}`
}

export function remainingTransportBudgetMs(input: {
	startedAtMs: number
	nowMs?: number
	budgetMs?: number
}) {
	const budget = input.budgetMs ?? hostedExecuteTransportBudgetMs
	const elapsed = (input.nowMs ?? performance.now()) - input.startedAtMs
	if (!Number.isFinite(elapsed)) return budget
	return Math.max(0, budget - elapsed)
}

export type DetachableAbortSignal = {
	signal: AbortSignal
	/**
	 * Stop forwarding upstream aborts. Call this before returning a follow
	 * handle so completing the HTTP response does not cancel the sandbox.
	 */
	detach: () => void
}

/**
 * Abort `signal` when `upstream` aborts, until `detach`. A caller cancel
 * before the transport budget still stops the sandbox. The abort that follows
 * an intentional early return does not.
 */
export function createDetachableAbortSignal(
	upstream: AbortSignal | undefined,
): DetachableAbortSignal {
	const controller = new AbortController()
	if (!upstream) {
		return {
			signal: controller.signal,
			detach() {},
		}
	}
	let detached = false
	const forward = () => {
		if (detached || controller.signal.aborted) return
		const reason: unknown = upstream.reason
		if (reason === undefined) {
			controller.abort()
			return
		}
		controller.abort(reason)
	}
	if (upstream.aborted) forward()
	else upstream.addEventListener('abort', forward)
	return {
		signal: controller.signal,
		detach() {
			detached = true
			upstream.removeEventListener('abort', forward)
		},
	}
}

export type TransportBudgetRace<T> =
	| { kind: 'settled'; value: T }
	| { kind: 'rejected'; error: unknown }
	| { kind: 'budget' }

/**
 * Settle with the work's outcome, or with `budget` when `budgetMs` elapses
 * first. The work promise is left running either way. Rejections are returned
 * as `rejected` so a budget win cannot leave a later rejection unhandled.
 */
export async function raceWithTransportBudget<T>(
	work: Promise<T>,
	budgetMs: number,
): Promise<TransportBudgetRace<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const tracked = work.then(
		(value) => ({ settled: true as const, value }),
		(error: unknown) => ({ settled: false as const, error }),
	)
	try {
		return await Promise.race([
			tracked.then((outcome) =>
				outcome.settled
					? { kind: 'settled' as const, value: outcome.value }
					: { kind: 'rejected' as const, error: outcome.error },
			),
			new Promise<TransportBudgetRace<T>>((resolve) => {
				timer = setTimeout(
					() => resolve({ kind: 'budget' }),
					Math.max(0, budgetMs),
				)
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

export type TransportWorkPeek<T> =
	| { ok: true; value: T }
	| { ok: false; error: unknown }

/**
 * Race `work` against the budget and remember a same-turn settlement so the
 * caller can prefer a finished module over a follow handle.
 */
export function watchExecuteTransport<T>(work: Promise<T>, budgetMs: number) {
	let latest: TransportWorkPeek<T> | null = null
	void work.then(
		(value) => {
			latest = { ok: true, value }
		},
		(error: unknown) => {
			latest = { ok: false, error }
		},
	)
	return {
		raced: raceWithTransportBudget(work, budgetMs),
		peek() {
			return latest
		},
	}
}
