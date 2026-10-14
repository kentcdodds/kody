import {
	artifactsReceivePackBodyLimitBytes,
	artifactsReceivePackBusyBackoffMs,
	defaultReceivePackSleep,
	isArtifactsGitReceivePackBusyResponse,
	readCappedResponseText,
	waitOutReceivePackBusy,
} from '@kody-internal/shared/artifacts-receive-pack-wait.ts'
import {
	isRepoPushQueueUpstreamUrl,
	repoPushQueueAttemptsHeader,
	repoPushQueueBudgetMs,
	repoPushQueueChunkBytes,
	repoPushQueueInMemorySendBytes,
	repoPushQueueMaxEntries,
	repoPushQueueMaxQueuedBytes,
	repoPushQueueOutcomeHeader,
	repoPushQueuePathHeader,
	repoPushQueuePathQueued,
	repoPushQueuePositionHeader,
	repoPushQueueRetryAfterSeconds,
	repoPushQueueUpstreamHeader,
	repoPushQueueWaitMsHeader,
} from '@kody-internal/shared/repo-push-queue-protocol.ts'

/**
 * Pack bytes for queued pushes. Backed by Durable Object storage in
 * production. Only pack chunks are persisted: the caller's Artifacts token
 * stays in memory, so a reset instance cannot resume a stored push and
 * clears leftovers on start instead.
 */
export type RepoPushQueueStore = {
	putChunk(entryId: string, index: number, bytes: Uint8Array): Promise<void>
	getChunk(entryId: string, index: number): Promise<Uint8Array | undefined>
	deleteEntry(entryId: string, chunkCount: number): Promise<void>
	/** Resolves once earlier writes are durable. */
	sync(): Promise<void>
}

export type RepoPushQueueLimits = {
	budgetMs: number
	bodyLimitBytes: number
	chunkBytes: number
	maxEntries: number
	maxQueuedBytes: number
	inMemorySendBytes: number
	headersTimeoutMs: number
	busyBackoffMs: ReadonlyArray<number>
}

export const defaultRepoPushQueueLimits: RepoPushQueueLimits = {
	budgetMs: repoPushQueueBudgetMs,
	bodyLimitBytes: artifactsReceivePackBodyLimitBytes,
	chunkBytes: repoPushQueueChunkBytes,
	maxEntries: repoPushQueueMaxEntries,
	maxQueuedBytes: repoPushQueueMaxQueuedBytes,
	inMemorySendBytes: repoPushQueueInMemorySendBytes,
	headersTimeoutMs: 120_000,
	busyBackoffMs: artifactsReceivePackBusyBackoffMs,
}

export type RepoPushQueueEvent = {
	event:
		| 'landed'
		| 'sent'
		| 'rejected'
		| 'timeout'
		| 'unavailable'
		| 'abandoned-cleanup-failed'
	entryId?: string
	bytes?: number
	position?: number
	waitMs?: number
	attempts?: number
	status?: number
	outcome?: string
}

export type RepoPushQueueDeps = {
	store: RepoPushQueueStore
	fetch: (url: string, init: RequestInit) => Promise<Response>
	now?: () => number
	sleep?: (ms: number) => Promise<void>
	random?: () => number
	createId?: () => string
	limits?: Partial<RepoPushQueueLimits>
	log?: (event: RepoPushQueueEvent) => void
}

type QueueEntry = {
	id: string
	upstream: string
	headers: Headers
	bytes: number
	chunkCount: number
	landedAt: number
	deadlineMs: number
	position: number
	settle: (response: Response) => void
}

type RejectOutcome = 'timeout' | 'full' | 'unavailable'

const forwardedRequestHeaders = [
	'Authorization',
	'Content-Type',
	'Accept',
	'Git-Protocol',
] as const

const droppedResponseHeaders = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailers',
	'transfer-encoding',
	'upgrade',
	'content-length',
	'content-encoding',
])

class BodyLimitError extends Error {}
class QueueFullError extends Error {}
class BodyTimeoutError extends Error {}

/**
 * Per-repo FIFO write queue for Artifacts receive-pack. One instance lives
 * in one Durable Object (one per repo source id), so every Worker isolate
 * pushing to that repo shares this order.
 *
 * A push is enqueued only after its full pack has landed in storage. FIFO
 * order is landing order, so a slow upload never blocks pushes that already
 * landed. One push at a time is sent to Artifacts; Artifacts busy responses
 * (writers outside this queue) are retried with jittered backoff. Every push
 * has a 90s budget from arrival; the deadline is checked before each send.
 * An attempt already in flight is never aborted by the budget: cutting a
 * pack off mid-upload is worse than finishing it.
 *
 * Shutdown: Cloudflare stops an outgoing instance's storage access when a
 * new version takes over, and lets requests that do not touch storage
 * finish. Small packs are read into memory before the send, so the in-flight
 * push completes; landings and queued pushes on the old instance fail their
 * storage access and get a 503 the client retries against the new instance.
 */
export class RepoPushQueue {
	readonly #store: RepoPushQueueStore
	readonly #fetch: RepoPushQueueDeps['fetch']
	readonly #now: () => number
	readonly #sleep: (ms: number) => Promise<void>
	readonly #random: () => number
	readonly #createId: () => string
	readonly #limits: RepoPushQueueLimits
	readonly #log: (event: RepoPushQueueEvent) => void

	readonly #waiting: Array<QueueEntry> = []
	#running: QueueEntry | null = null
	#landingCount = 0
	#reservedBytes = 0

	constructor(deps: RepoPushQueueDeps) {
		this.#store = deps.store
		this.#fetch = deps.fetch
		this.#now = deps.now ?? Date.now
		this.#sleep = deps.sleep ?? defaultReceivePackSleep
		this.#random = deps.random ?? Math.random
		this.#createId = deps.createId ?? (() => crypto.randomUUID())
		this.#limits = { ...defaultRepoPushQueueLimits, ...deps.limits }
		this.#log = deps.log ?? (() => {})
	}

	/** Pushes landing, waiting, or running. */
	get depth() {
		return this.#landingCount + this.#waiting.length + (this.#running ? 1 : 0)
	}

	async handle(request: Request): Promise<Response> {
		const arrivedAt = this.#now()
		const deadlineMs = arrivedAt + this.#limits.budgetMs
		const upstream = request.headers.get(repoPushQueueUpstreamHeader)
		if (!upstream || !isRepoPushQueueUpstreamUrl(upstream)) {
			return textResponse(400, 'Invalid push queue upstream.')
		}
		if (this.depth >= this.#limits.maxEntries) {
			return this.#reject('full', { waitMs: 0 })
		}

		const id = this.#createId()
		this.#landingCount += 1
		let landed: { bytes: number; chunkCount: number }
		try {
			landed = await this.#land(id, request.body, deadlineMs)
		} catch (error) {
			if (error instanceof BodyLimitError) {
				this.#log({ event: 'rejected', entryId: id, outcome: 'too_large' })
				return textResponse(
					413,
					`receive-pack body exceeds ${this.#limits.bodyLimitBytes} byte limit`,
				)
			}
			if (error instanceof BodyTimeoutError) {
				this.#log({ event: 'rejected', entryId: id, outcome: 'body_timeout' })
				return textResponse(408, 'receive-pack body read timed out')
			}
			if (error instanceof QueueFullError) {
				return this.#reject('full', { waitMs: 0 })
			}
			return this.#reject('unavailable', { waitMs: 0 })
		} finally {
			this.#landingCount -= 1
		}

		const headers = new Headers()
		for (const name of forwardedRequestHeaders) {
			const value = request.headers.get(name)
			if (value) headers.set(name, value)
		}
		const position = this.#waiting.length + (this.#running ? 1 : 0)
		const landedAt = this.#now()
		this.#log({ event: 'landed', entryId: id, bytes: landed.bytes, position })
		return new Promise<Response>((resolve) => {
			this.#waiting.push({
				id,
				upstream,
				headers,
				bytes: landed.bytes,
				chunkCount: landed.chunkCount,
				landedAt,
				deadlineMs,
				position,
				settle: resolve,
			})
			this.#pump()
		})
	}

	async #land(
		id: string,
		body: ReadableStream<Uint8Array> | null,
		deadlineMs: number,
	): Promise<{ bytes: number; chunkCount: number }> {
		const chunkBytes = this.#limits.chunkBytes
		let total = 0
		let chunkCount = 0
		let pending = new Uint8Array(chunkBytes)
		let pendingLength = 0
		const flush = async (bytes: Uint8Array) => {
			await this.#store.putChunk(id, chunkCount, bytes)
			chunkCount += 1
		}
		const reader = body?.getReader() ?? null
		let timer: ReturnType<typeof setTimeout> | undefined
		const timedOut = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new BodyTimeoutError()),
				Math.max(0, deadlineMs - this.#now()),
			)
		})
		try {
			while (reader) {
				const { done, value } = await Promise.race([reader.read(), timedOut])
				if (done) break
				total += value.byteLength
				if (total > this.#limits.bodyLimitBytes) throw new BodyLimitError()
				if (
					this.#reservedBytes + value.byteLength >
					this.#limits.maxQueuedBytes
				) {
					throw new QueueFullError()
				}
				this.#reservedBytes += value.byteLength
				let offset = 0
				while (offset < value.byteLength) {
					const take = Math.min(
						chunkBytes - pendingLength,
						value.byteLength - offset,
					)
					pending.set(value.subarray(offset, offset + take), pendingLength)
					pendingLength += take
					offset += take
					if (pendingLength === chunkBytes) {
						await Promise.race([flush(pending), timedOut])
						pending = new Uint8Array(chunkBytes)
						pendingLength = 0
					}
				}
			}
			if (pendingLength > 0) {
				await Promise.race([flush(pending.slice(0, pendingLength)), timedOut])
			}
			await Promise.race([this.#store.sync(), timedOut])
			return { bytes: total, chunkCount }
		} catch (error) {
			this.#reservedBytes -= Math.min(total, this.#reservedBytes)
			if (reader) {
				try {
					await reader.cancel()
				} catch {
					// already errored or closed
				}
			}
			await this.#deleteQuietly(id, chunkCount + 1)
			throw error
		} finally {
			clearTimeout(timer)
		}
	}

	#pump() {
		if (this.#running) return
		const next = this.#waiting.shift()
		if (!next) return
		this.#running = next
		void this.#process(next)
			.catch(() => this.#reject('unavailable', { entry: next }))
			.then(async (response) => {
				next.settle(response)
				await this.#deleteQuietly(next.id, next.chunkCount)
				this.#reservedBytes -= Math.min(next.bytes, this.#reservedBytes)
				this.#running = null
				this.#pump()
			})
	}

	async #process(entry: QueueEntry): Promise<Response> {
		if (this.#now() >= entry.deadlineMs) {
			return this.#reject('timeout', { entry })
		}
		let loaded: Array<Uint8Array> | null = null
		if (entry.bytes <= this.#limits.inMemorySendBytes) {
			try {
				loaded = await this.#loadChunks(entry)
			} catch {
				return this.#reject('unavailable', { entry })
			}
		}
		let attempts = 0
		let firstSendAt: number | null = null
		const waited = await waitOutReceivePackBusy({
			deadlineMs: entry.deadlineMs,
			backoffMs: this.#limits.busyBackoffMs,
			sleep: this.#sleep,
			now: this.#now,
			random: this.#random,
			send: async () => {
				attempts += 1
				firstSendAt ??= this.#now()
				return this.#send(entry, loaded)
			},
			isBusy: (response, bodyText) =>
				isArtifactsGitReceivePackBusyResponse({
					status: response.status,
					bodyText,
				}),
			readBusyBody: readCappedResponseText,
		})
		const waitMs = (firstSendAt ?? this.#now()) - entry.landedAt
		if (waited.kind === 'timeout') {
			return this.#reject('timeout', { entry, waitMs, attempts })
		}
		const upstream = waited.response
		// Drain the report-status body before the next push is sent so the
		// Artifacts lock is released in queue order.
		const body = await upstream.arrayBuffer()
		this.#log({
			event: 'sent',
			entryId: entry.id,
			bytes: entry.bytes,
			position: entry.position,
			waitMs,
			attempts,
			status: upstream.status,
		})
		const headers = new Headers()
		upstream.headers.forEach((value, key) => {
			if (droppedResponseHeaders.has(key.toLowerCase())) return
			headers.set(key, value)
		})
		setQueueHeaders(headers, { position: entry.position, waitMs, attempts })
		return new Response(body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		})
	}

	async #loadChunks(entry: QueueEntry) {
		const chunks: Array<Uint8Array> = []
		for (let index = 0; index < entry.chunkCount; index += 1) {
			const chunk = await this.#store.getChunk(entry.id, index)
			if (!chunk) throw new Error(`missing push queue chunk ${index}`)
			chunks.push(chunk)
		}
		return chunks
	}

	async #send(
		entry: QueueEntry,
		loaded: Array<Uint8Array> | null,
	): Promise<Response> {
		const store = this.#store
		let index = 0
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (index >= entry.chunkCount) {
					controller.close()
					return
				}
				const chunk = loaded
					? loaded[index]
					: await store.getChunk(entry.id, index)
				if (!chunk) {
					controller.error(new Error(`missing push queue chunk ${index}`))
					return
				}
				index += 1
				controller.enqueue(chunk)
			},
		})
		const controller = new AbortController()
		const timeoutId = setTimeout(
			() => controller.abort(),
			this.#limits.headersTimeoutMs,
		)
		try {
			return await this.#fetch(entry.upstream, {
				method: 'POST',
				headers: entry.headers,
				body,
				signal: controller.signal,
				duplex: 'half',
			} as RequestInit)
		} finally {
			clearTimeout(timeoutId)
		}
	}

	async #deleteQuietly(id: string, chunkCount: number) {
		try {
			await this.#store.deleteEntry(id, chunkCount)
		} catch {
			// A fenced (replaced) instance cannot delete; the new instance
			// clears leftovers when it starts.
			this.#log({ event: 'abandoned-cleanup-failed', entryId: id })
		}
	}

	#reject(
		outcome: RejectOutcome,
		input: { entry?: QueueEntry; waitMs?: number; attempts?: number },
	): Response {
		const waitMs =
			input.waitMs ?? (input.entry ? this.#now() - input.entry.landedAt : 0)
		const event =
			outcome === 'timeout'
				? 'timeout'
				: outcome === 'unavailable'
					? 'unavailable'
					: 'rejected'
		this.#log({
			event,
			entryId: input.entry?.id,
			waitMs,
			attempts: input.attempts ?? 0,
			outcome,
		})
		return repoPushQueueRetryResponse(outcome, {
			position: input.entry?.position ?? null,
			waitMs,
			attempts: input.attempts ?? 0,
		})
	}
}

function setQueueHeaders(
	headers: Headers,
	input: { position: number | null; waitMs: number; attempts: number },
) {
	headers.set('Cache-Control', 'no-store')
	headers.set(repoPushQueuePathHeader, repoPushQueuePathQueued)
	if (input.position !== null) {
		headers.set(repoPushQueuePositionHeader, String(input.position))
	}
	headers.set(repoPushQueueWaitMsHeader, String(Math.max(0, input.waitMs)))
	headers.set(repoPushQueueAttemptsHeader, String(input.attempts))
}

const retryMessages: Record<RejectOutcome, string> = {
	timeout: 'repository busy, retry',
	full: 'repository push queue full, retry',
	unavailable: 'repository push queue unavailable, retry',
}

export function repoPushQueueRetryResponse(
	outcome: RejectOutcome,
	input: { position: number | null; waitMs: number; attempts: number } = {
		position: null,
		waitMs: 0,
		attempts: 0,
	},
) {
	const headers = new Headers({
		'Content-Type': 'text/plain; charset=utf-8',
		'Retry-After': String(repoPushQueueRetryAfterSeconds),
	})
	setQueueHeaders(headers, input)
	headers.set(repoPushQueueOutcomeHeader, outcome)
	return new Response(retryMessages[outcome], { status: 503, headers })
}

function textResponse(status: number, message: string) {
	return new Response(message, {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
			[repoPushQueuePathHeader]: repoPushQueuePathQueued,
		},
	})
}
