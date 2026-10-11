import { withLanding } from '#mcp/secrets/echo-redaction.ts'

/**
 * Longest gap the gateway waits on upstream for the next response body
 * chunk. Each chunk resets it, so a stream that keeps sending bytes only
 * stops at the overall deadline. Time the consumer spends not reading does
 * not count.
 */
export const outboundFetchIdleTimeoutMs = 60_000

export type OutboundFetchDeadlineOutcome = 'success' | 'error'

export type OutboundFetchDeadline = {
	/** Aborts the outbound request on the overall or idle deadline. */
	signal: AbortSignal
	/**
	 * Wraps the upstream body so idle gaps and the overall deadline bound
	 * it while it streams. Resolves {@link done} when the body ends.
	 */
	track(response: Response): Response
	/** Settles the deadline for a fetch that failed before a response. */
	fail(): void
	/** Settles once the body ended, errored, was cancelled, or timed out. */
	done: Promise<OutboundFetchDeadlineOutcome>
}

/**
 * One deadline for one gateway fetch: `totalMs` from start until the body
 * ends (headers included) plus an `idleMs` gap between body chunks. `null`
 * `totalMs` disables both timers so only `callerSignal` can abort.
 */
export function createOutboundFetchDeadline(input: {
	totalMs: number | null
	idleMs: number
	callerSignal: AbortSignal | null
}): OutboundFetchDeadline {
	const controller = new AbortController()
	const { signal } = controller
	let resolveDone: (outcome: OutboundFetchDeadlineOutcome) => void = () => {}
	const done = new Promise<OutboundFetchDeadlineOutcome>((resolve) => {
		resolveDone = resolve
	})
	let settled = false
	let totalTimer: ReturnType<typeof setTimeout> | undefined
	let idleTimer: ReturnType<typeof setTimeout> | undefined
	const abortWithTimeout = (message: string) => {
		controller.abort(new DOMException(message, 'TimeoutError'))
	}
	const forwardCallerAbort = () => controller.abort(input.callerSignal?.reason)
	const finish = (outcome: OutboundFetchDeadlineOutcome) => {
		if (settled) return
		settled = true
		clearTimeout(totalTimer)
		clearTimeout(idleTimer)
		input.callerSignal?.removeEventListener('abort', forwardCallerAbort)
		resolveDone(outcome)
	}

	if (input.callerSignal?.aborted) {
		forwardCallerAbort()
	} else {
		input.callerSignal?.addEventListener('abort', forwardCallerAbort, {
			once: true,
		})
	}
	const { totalMs } = input
	if (totalMs !== null) {
		totalTimer = setTimeout(
			() =>
				abortWithTimeout(
					`Outbound fetch exceeded its ${formatSeconds(totalMs)} overall deadline.`,
				),
			Math.max(1, totalMs),
		)
	}

	return {
		signal,
		done,
		fail: () => finish('error'),
		track(response) {
			const upstream = response.body
			if (!upstream || settled) {
				finish(signal.aborted ? 'error' : 'success')
				return response
			}
			const reader = upstream.getReader()
			let bodyController: ReadableStreamDefaultController<Uint8Array> | null =
				null
			const onAbort = () => {
				clearTimeout(idleTimer)
				try {
					bodyController?.error(signal.reason)
				} catch {
					// Already closed or errored.
				}
				reader.cancel(signal.reason).catch(() => {})
				finish('error')
			}
			const body = new ReadableStream<Uint8Array>({
				start(streamController) {
					bodyController = streamController
					if (signal.aborted) onAbort()
					else signal.addEventListener('abort', onAbort, { once: true })
				},
				async pull(streamController) {
					if (totalMs !== null) {
						idleTimer = setTimeout(
							() =>
								abortWithTimeout(
									`Outbound fetch response stalled: no bytes for ${formatSeconds(input.idleMs)}.`,
								),
							Math.max(1, input.idleMs),
						)
					}
					let chunk: ReadableStreamReadResult<Uint8Array>
					try {
						chunk = await reader.read()
					} catch (error) {
						clearTimeout(idleTimer)
						if (!signal.aborted) {
							streamController.error(error)
							finish('error')
						}
						return
					}
					clearTimeout(idleTimer)
					if (signal.aborted) return
					if (chunk.done) {
						streamController.close()
						signal.removeEventListener('abort', onAbort)
						finish('success')
						return
					}
					streamController.enqueue(chunk.value)
				},
				cancel(reason) {
					signal.removeEventListener('abort', onAbort)
					finish('success')
					return reader.cancel(reason)
				},
			})
			return withLanding(
				new Response(body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
					cf: response.cf,
				}),
				{ url: response.url, redirected: response.redirected },
			)
		},
	}
}

function formatSeconds(ms: number) {
	return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}
