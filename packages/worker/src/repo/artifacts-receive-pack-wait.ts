/**
 * Bounded wait helpers for Cloudflare Artifacts receive-pack lock contention.
 *
 * Artifacts serializes receive-pack per repository and returns
 * `artifacts_git_receive_pack_busy` when another pack is in flight. Kody's
 * smart-HTTP proxy holds the client connection and retries upstream instead of
 * rejecting immediately. A per-key FIFO gate keeps same-isolate waiters ordered
 * and prevents a local stampede; cross-isolate fairness still relies on
 * Artifacts' lock plus retry backoff (a Durable Object gate is the follow-up
 * for global FIFO).
 */

/** Total wall time spent waiting/retrying busy before returning 503. */
export const artifactsReceivePackWaitBudgetMs = 45_000

/**
 * Backoff steps between busy retries (full jitter applied per step).
 * Kept short so a free lock is claimed quickly under multi-agent push storms.
 */
export const artifactsReceivePackBusyBackoffMs = [
	50, 100, 200, 400, 800, 1_600, 3_200,
] as const

export const artifactsReceivePackBodyLimitBytes = 40 * 1024 * 1024

export class ReceivePackWaitTimeoutError extends Error {
	constructor(message = 'receive-pack wait timed out') {
		super(message)
		this.name = 'ReceivePackWaitTimeoutError'
	}
}

export class ReceivePackBodyTooLargeError extends Error {
	constructor(limitBytes: number) {
		super(`receive-pack body exceeds ${limitBytes} byte buffer limit`)
		this.name = 'ReceivePackBodyTooLargeError'
	}
}

export class ReceivePackBodyTimeoutError extends Error {
	constructor(message = 'receive-pack body read timed out') {
		super(message)
		this.name = 'ReceivePackBodyTimeoutError'
	}
}

type GateEntry = {
	running: boolean
	queue: Array<{
		resolve: () => void
		reject: (error: Error) => void
		timer: ReturnType<typeof setTimeout>
	}>
}

/** Isolate-local FIFO gates keyed by artifact source id (or equivalent). */
const receivePackGates = new Map<string, GateEntry>()

function getGate(key: string): GateEntry {
	const existing = receivePackGates.get(key)
	if (existing) return existing
	const created: GateEntry = { running: false, queue: [] }
	receivePackGates.set(key, created)
	return created
}

/**
 * Acquire exclusive access for `key` in FIFO order. Rejects with
 * `ReceivePackWaitTimeoutError` when `timeoutMs` elapses before the turn.
 */
export function acquireReceivePackGate(
	key: string,
	timeoutMs: number,
): Promise<void> {
	const gate = getGate(key)
	if (!gate.running && gate.queue.length === 0) {
		gate.running = true
		return Promise.resolve()
	}
	return new Promise<void>((resolve, reject) => {
		const waiter = {
			resolve: () => {
				clearTimeout(waiter.timer)
				resolve()
			},
			reject: (error: Error) => {
				clearTimeout(waiter.timer)
				reject(error)
			},
			timer: setTimeout(
				() => {
					const index = gate.queue.indexOf(waiter)
					if (index >= 0) gate.queue.splice(index, 1)
					if (gate.queue.length === 0 && !gate.running) {
						receivePackGates.delete(key)
					}
					reject(new ReceivePackWaitTimeoutError())
				},
				Math.max(0, timeoutMs),
			),
		}
		gate.queue.push(waiter)
	})
}

export function releaseReceivePackGate(key: string) {
	const gate = receivePackGates.get(key)
	if (!gate) return
	const next = gate.queue.shift()
	if (next) {
		gate.running = true
		next.resolve()
		return
	}
	gate.running = false
	receivePackGates.delete(key)
}

/**
 * Run `fn` while holding the per-key FIFO gate. Always releases, including on
 * timeout while waiting for the turn.
 */
export async function withReceivePackGate<T>(
	key: string,
	timeoutMs: number,
	fn: () => Promise<T>,
): Promise<T> {
	await acquireReceivePackGate(key, timeoutMs)
	try {
		return await fn()
	} finally {
		releaseReceivePackGate(key)
	}
}

export function computeReceivePackBusyBackoffMs(
	attemptIndex: number,
	backoffMs: ReadonlyArray<number> = artifactsReceivePackBusyBackoffMs,
	random: () => number = Math.random,
) {
	const capped =
		backoffMs[Math.min(attemptIndex, backoffMs.length - 1)] ??
		backoffMs[backoffMs.length - 1] ??
		50
	// `Math.random` is in [0, 1); clamp so injectable RNGs cannot exceed the step.
	const unit = Math.min(Math.max(random(), 0), 0.999_999_999)
	return Math.floor(unit * (capped + 1))
}

export function defaultReceivePackSleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * Buffer a request body up to `limitBytes` so receive-pack can be retried on
 * Artifacts busy. Throws `ReceivePackBodyTooLargeError` when the stream
 * exceeds the limit.
 */
export async function readReceivePackBodyWithLimit(
	body: ReadableStream<Uint8Array> | null,
	limitBytes = artifactsReceivePackBodyLimitBytes,
	timeoutMs?: number,
): Promise<Uint8Array> {
	if (!body) return new Uint8Array()
	const reader = body.getReader()
	const chunks: Array<Uint8Array> = []
	let total = 0
	// Bound the whole read so a stalled upload cannot hold the gate forever.
	let timer: ReturnType<typeof setTimeout> | undefined
	const timedOut =
		timeoutMs === undefined
			? null
			: new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new ReceivePackBodyTimeoutError()),
						Math.max(0, timeoutMs),
					)
				})
	try {
		for (;;) {
			let result: ReadableStreamReadResult<Uint8Array>
			try {
				result = timedOut
					? await Promise.race([reader.read(), timedOut])
					: await reader.read()
			} catch (error) {
				if (error instanceof ReceivePackBodyTimeoutError) {
					try {
						await reader.cancel()
					} catch {
						// ignore cancel failures after a timeout
					}
				}
				throw error
			}
			const { done, value } = result
			if (done) break
			total += value.byteLength
			if (total > limitBytes) {
				try {
					await reader.cancel()
				} catch {
					// ignore cancel failures after a size reject
				}
				throw new ReceivePackBodyTooLargeError(limitBytes)
			}
			chunks.push(value)
		}
	} finally {
		if (timer !== undefined) clearTimeout(timer)
		try {
			reader.releaseLock()
		} catch {
			// already cancelled or released
		}
	}
	if (chunks.length === 0) return new Uint8Array()
	if (chunks.length === 1) return chunks[0]!
	const merged = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		merged.set(chunk, offset)
		offset += chunk.byteLength
	}
	return merged
}

/**
 * Call `send` until it returns a non-busy response or the wait budget expires.
 * Busy response bodies are consumed via `readBusyBody` before the next attempt.
 */
export async function waitOutReceivePackBusy(input: {
	deadlineMs: number
	send: (attempt: number) => Promise<Response>
	isBusy: (response: Response, bodyText: string) => boolean
	readBusyBody: (response: Response) => Promise<string>
	backoffMs?: ReadonlyArray<number>
	sleep?: (ms: number) => Promise<void>
	now?: () => number
	random?: () => number
}): Promise<{ kind: 'response'; response: Response } | { kind: 'timeout' }> {
	const backoffMs = input.backoffMs ?? artifactsReceivePackBusyBackoffMs
	const sleep = input.sleep ?? defaultReceivePackSleep
	const now = input.now ?? Date.now
	const random = input.random ?? Math.random

	for (let attempt = 0; ; attempt += 1) {
		// Never start a new upstream attempt once the wait budget is spent (e.g.
		// the gate turn arrived right at the deadline). An attempt already in
		// flight is not aborted: cancelling a partially-applied pack is worse.
		if (now() >= input.deadlineMs) {
			return { kind: 'timeout' }
		}
		const response = await input.send(attempt)
		// Successful / non-error packs must not be sniffed or retried.
		if (response.ok) {
			return { kind: 'response', response }
		}
		const bodyText = await input.readBusyBody(response)
		if (!input.isBusy(response, bodyText)) {
			return {
				kind: 'response',
				response: new Response(bodyText, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				}),
			}
		}
		const remaining = input.deadlineMs - now()
		if (remaining <= 0) {
			return { kind: 'timeout' }
		}
		const delay = Math.min(
			remaining,
			computeReceivePackBusyBackoffMs(attempt, backoffMs, random),
		)
		if (delay > 0) {
			await sleep(delay)
		}
		if (now() >= input.deadlineMs) {
			return { kind: 'timeout' }
		}
	}
}
