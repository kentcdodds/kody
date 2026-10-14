/**
 * Bounded wait helpers for Cloudflare Artifacts receive-pack lock contention.
 *
 * Artifacts serializes receive-pack per repository and reports
 * `artifacts_git_receive_pack_busy` when another pack is in flight, either as
 * an HTTP error body or in-band as HTTP 200 with a sideband fatal (band 3)
 * pkt-line. Kody's smart-HTTP proxy holds the client connection and retries
 * upstream instead of rejecting immediately. The isolate-local FIFO gate keeps
 * same-isolate waiters ordered; `RepoPushQueueV1` (kody-push-queue) provides
 * global per-repo FIFO for flagged repos.
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

/** Upstream Artifacts lock-contention code observed on concurrent receive-pack. */
export const artifactsGitReceivePackBusyCode = 'artifacts_git_receive_pack_busy'
export const artifactsReceivePackBusyRetryAfterSeconds = 5
export const repositoryBusyRetryMessage = 'repository busy, retry'

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
		if (response.ok) {
			// Artifacts reports lock contention in-band: HTTP 200 whose
			// receive-pack result is a sideband fatal (band 3) busy packet.
			const sniffed = await sniffInBandReceivePackBusy(response)
			if (!sniffed.busy) {
				return { kind: 'response', response: sniffed.response }
			}
		} else {
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

export const plainRepoGitHttpErrorBodyReadLimitBytes = 64 * 1024

/** Read up to `limitBytes` of an error response for busy-code sniffing. */
export async function readCappedResponseText(
	response: Response,
	limitBytes = plainRepoGitHttpErrorBodyReadLimitBytes,
): Promise<string> {
	if (!response.body) return ''
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let result = ''
	let totalBytes = 0
	try {
		while (totalBytes < limitBytes) {
			let chunk: ReadableStreamReadResult<Uint8Array>
			try {
				chunk = await reader.read()
			} catch {
				// Partial body is still useful when the upstream stream errors mid-read.
				break
			}
			if (chunk.done) break
			totalBytes += chunk.value.byteLength
			result += decoder.decode(chunk.value, { stream: true })
		}
	} catch {
		// Return whatever we sniffed before an unexpected failure.
	} finally {
		try {
			reader.releaseLock()
		} catch {
			try {
				await reader.cancel()
			} catch {
				// ignore
			}
		}
	}
	return result
}

/** Prefix of a 2xx receive-pack result inspected for an in-band busy packet. */
export const receivePackInBandSniffLimitBytes = 64 * 1024

const busyPacketBytes = new TextEncoder().encode(
	artifactsGitReceivePackBusyCode,
)

type PktLineScan =
	| { kind: 'busy' }
	| { kind: 'not-busy' }
	| { kind: 'need-more' }

function containsBytes(haystack: Uint8Array, needle: Uint8Array) {
	outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
		for (let j = 0; j < needle.length; j += 1) {
			if (haystack[i + j] !== needle[j]) continue outer
		}
		return true
	}
	return false
}

function parseHexLength(bytes: Uint8Array, offset: number) {
	let value = 0
	for (let i = 0; i < 4; i += 1) {
		const code = bytes[offset + i]!
		const digit =
			code >= 0x30 && code <= 0x39
				? code - 0x30
				: code >= 0x61 && code <= 0x66
					? code - 0x57
					: code >= 0x41 && code <= 0x46
						? code - 0x37
						: -1
		if (digit < 0) return null
		value = value * 16 + digit
	}
	return value
}

/**
 * Scan leading pkt-lines of a receive-pack result. Busy is a band-3 (fatal)
 * or `ERR ` packet carrying the Artifacts busy code; band-2 progress is
 * skipped; any other packet means the push was accepted for processing.
 */
export function scanReceivePackResultForBusy(bytes: Uint8Array): PktLineScan {
	let offset = 0
	while (offset + 4 <= bytes.length) {
		const length = parseHexLength(bytes, offset)
		if (length === null) return { kind: 'not-busy' }
		if (length < 4) {
			// flush / delim / response-end: the result ended without busy.
			return { kind: 'not-busy' }
		}
		if (offset + length > bytes.length) return { kind: 'need-more' }
		const payload = bytes.subarray(offset + 4, offset + length)
		const band = payload[0]
		if (band === 2) {
			offset += length
			continue
		}
		const isFatal =
			band === 3 ||
			(payload.length >= 4 &&
				payload[0] === 0x45 &&
				payload[1] === 0x52 &&
				payload[2] === 0x52 &&
				payload[3] === 0x20)
		return isFatal && containsBytes(payload, busyPacketBytes)
			? { kind: 'busy' }
			: { kind: 'not-busy' }
	}
	return { kind: 'need-more' }
}

function concatBytes(chunks: Array<Uint8Array>, total: number) {
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
 * Inspect the head of a 2xx receive-pack result for an in-band busy packet.
 * Non-busy results are returned with an equivalent body (sniffed prefix plus
 * the untouched remainder of the upstream stream).
 */
export async function sniffInBandReceivePackBusy(
	response: Response,
	limitBytes = receivePackInBandSniffLimitBytes,
): Promise<{ busy: true } | { busy: false; response: Response }> {
	if (!response.body) return { busy: false, response }
	const reader = response.body.getReader()
	const chunks: Array<Uint8Array> = []
	let total = 0
	let done = false
	let verdict: PktLineScan = { kind: 'need-more' }
	while (verdict.kind === 'need-more' && total < limitBytes) {
		const result = await reader.read()
		if (result.done) {
			done = true
			break
		}
		chunks.push(result.value)
		total += result.value.byteLength
		verdict = scanReceivePackResultForBusy(concatBytes(chunks, total))
	}
	if (verdict.kind === 'busy') {
		try {
			await reader.cancel()
		} catch {
			// busy body already consumed or upstream closed
		}
		return { busy: true }
	}
	const prefix = concatBytes(chunks, total)
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			if (prefix.byteLength > 0) controller.enqueue(prefix)
			if (done) controller.close()
		},
		async pull(controller) {
			const result = await reader.read()
			if (result.done) {
				controller.close()
				return
			}
			controller.enqueue(result.value)
		},
		async cancel(reason) {
			await reader.cancel(reason)
		},
	})
	return {
		busy: false,
		response: new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		}),
	}
}

export function isArtifactsGitReceivePackBusyResponse(input: {
	status: number
	bodyText: string
}) {
	if (input.status >= 200 && input.status < 300) return false
	return input.bodyText.includes(artifactsGitReceivePackBusyCode)
}

export function repositoryBusyRetryResponse(
	retryAfterSeconds = artifactsReceivePackBusyRetryAfterSeconds,
) {
	return new Response(repositoryBusyRetryMessage, {
		status: 503,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
			'Retry-After': String(retryAfterSeconds),
		},
	})
}
