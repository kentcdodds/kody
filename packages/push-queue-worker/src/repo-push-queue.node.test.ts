import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	repoPushQueueAttemptsHeader,
	repoPushQueueOutcomeHeader,
	repoPushQueuePathHeader,
	repoPushQueuePositionHeader,
	repoPushQueueSourceIdHeader,
	repoPushQueueUpstreamHeader,
	repoPushQueueV1Path,
	repoPushQueueWaitMsHeader,
} from '@kody-internal/shared/repo-push-queue-protocol.ts'
import {
	createDurableObjectPushQueueStore,
	RepoPushQueueV1,
	routeToRepoPushQueue,
} from './index.ts'
import { RepoPushQueue, type RepoPushQueueStore } from './repo-push-queue.ts'

const sourceId = '57a9ce42-dfc2-4867-bc01-2c0d05f23f07'
const upstream = 'https://artifacts.example/git/repo.git/git-receive-pack'
const busyBody = '{"error":"artifacts_git_receive_pack_busy"}'

function createMemoryStore() {
	const chunks = new Map<string, Uint8Array>()
	const state = { fenced: false, puts: 0, maxChunkBytes: 0 }
	const assertLive = () => {
		if (state.fenced) throw new Error('Durable Object storage fenced')
	}
	const store: RepoPushQueueStore = {
		async putChunk(entryId, index, bytes) {
			assertLive()
			state.puts += 1
			state.maxChunkBytes = Math.max(state.maxChunkBytes, bytes.byteLength)
			chunks.set(`${entryId}:${index}`, bytes.slice())
		},
		async getChunk(entryId, index) {
			assertLive()
			return chunks.get(`${entryId}:${index}`)
		},
		async deleteEntry(entryId, chunkCount) {
			assertLive()
			for (let index = 0; index < chunkCount; index += 1) {
				chunks.delete(`${entryId}:${index}`)
			}
		},
		async sync() {
			assertLive()
		},
	}
	return { store, chunks, state }
}

function deferred<T = void>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

function pushRequest(
	body: BodyInit | ReadableStream<Uint8Array> | null,
	headers: Record<string, string> = {},
) {
	return new Request(`https://push-queue.internal${repoPushQueueV1Path}`, {
		method: 'POST',
		headers: {
			Authorization: 'Bearer art_v1_token',
			'Content-Type': 'application/x-git-receive-pack-request',
			[repoPushQueueSourceIdHeader]: sourceId,
			[repoPushQueueUpstreamHeader]: upstream,
			...headers,
		},
		body,
		duplex: 'half',
	} as RequestInit)
}

function manualStream() {
	let controller!: ReadableStreamDefaultController<Uint8Array>
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c
		},
	})
	return { stream, controller }
}

async function settle() {
	for (let i = 0; i < 20; i += 1) await Promise.resolve()
	await new Promise((resolve) => setTimeout(resolve, 0))
}

test('pushes from separate isolates share one FIFO and reach Artifacts one at a time', async () => {
	const { store } = createMemoryStore()
	const sent: Array<string> = []
	let inFlight = 0
	let maxInFlight = 0
	const gates: Array<ReturnType<typeof deferred<void>>> = []
	const queue = new RepoPushQueue({
		store,
		fetch: async (_url, init) => {
			inFlight += 1
			maxInFlight = Math.max(maxInFlight, inFlight)
			const text = await new Response(init.body).text()
			sent.push(text)
			const gate = deferred()
			gates.push(gate)
			await gate.promise
			inFlight -= 1
			return new Response(`ok ${text}`, { status: 200 })
		},
	})
	// Every origin isolate resolves the same Durable Object by source id.
	const namespace = {
		idFromName: (name: string) => name,
		get: () => ({ fetch: (request: Request) => queue.handle(request) }),
	} as unknown as DurableObjectNamespace

	const isolateA = routeToRepoPushQueue(pushRequest('push-1'), namespace)
	await settle()
	const isolateB = routeToRepoPushQueue(pushRequest('push-2'), namespace)
	await settle()
	const isolateC = routeToRepoPushQueue(pushRequest('push-3'), namespace)
	await settle()

	expect(sent).toEqual(['push-1'])
	gates[0]!.resolve()
	await settle()
	expect(sent).toEqual(['push-1', 'push-2'])
	gates[1]!.resolve()
	await settle()
	gates[2]!.resolve()

	const responses = await Promise.all([isolateA, isolateB, isolateC])
	expect(sent).toEqual(['push-1', 'push-2', 'push-3'])
	expect(maxInFlight).toBe(1)
	expect(await Promise.all(responses.map((r) => r.text()))).toEqual([
		'ok push-1',
		'ok push-2',
		'ok push-3',
	])
	expect(
		responses.map((r) => r.headers.get(repoPushQueuePositionHeader)),
	).toEqual(['0', '1', '2'])
	for (const response of responses) {
		expect(response.headers.get(repoPushQueuePathHeader)).toBe('v1')
		expect(response.headers.get(repoPushQueueAttemptsHeader)).toBe('1')
		expect(
			Number(response.headers.get(repoPushQueueWaitMsHeader)),
		).toBeGreaterThanOrEqual(0)
	}
})

test('a push joins the queue only after its pack has fully landed', async () => {
	const { store, chunks } = createMemoryStore()
	const sent: Array<string> = []
	const queue = new RepoPushQueue({
		store,
		fetch: async (_url, init) => {
			sent.push(await new Response(init.body).text())
			return new Response('ok', { status: 200 })
		},
	})
	const slow = manualStream()
	const slowPush = queue.handle(pushRequest(slow.stream))
	slow.controller.enqueue(new TextEncoder().encode('slow-'))
	await settle()
	expect(chunks.size).toBe(0)

	const fast = await queue.handle(pushRequest('fast'))
	expect(fast.status).toBe(200)
	expect(sent).toEqual(['fast'])

	slow.controller.enqueue(new TextEncoder().encode('upload'))
	slow.controller.close()
	expect((await slowPush).status).toBe(200)
	expect(sent).toEqual(['fast', 'slow-upload'])
	expect(chunks.size).toBe(0)
})

test('a landed push keeps its spot when the caller goes away', async () => {
	const { store } = createMemoryStore()
	const sent: Array<string> = []
	const first = deferred()
	const queue = new RepoPushQueue({
		store,
		fetch: async (_url, init) => {
			const text = await new Response(init.body).text()
			sent.push(text)
			if (text === 'first') await first.promise
			return new Response('ok', { status: 200 })
		},
	})
	const firstPush = queue.handle(pushRequest('first'))
	await settle()
	// Origin isolate dies after the handoff: nobody awaits this response.
	void queue.handle(pushRequest('abandoned'))
	await settle()
	first.resolve()
	await firstPush
	await settle()
	expect(sent).toEqual(['first', 'abandoned'])
	expect(queue.depth).toBe(0)
})

test('a handoff that dies before landing is never enqueued and leaves no chunks', async () => {
	const { store, chunks } = createMemoryStore()
	const sent: Array<string> = []
	const queue = new RepoPushQueue({
		store,
		limits: { chunkBytes: 4 },
		fetch: async () => {
			sent.push('sent')
			return new Response('ok')
		},
	})
	const broken = manualStream()
	const pending = queue.handle(pushRequest(broken.stream))
	broken.controller.enqueue(new TextEncoder().encode('partial-pack'))
	await settle()
	broken.controller.error(new Error('client disconnected'))
	const response = await pending
	expect(response.status).toBe(503)
	expect(response.headers.get('Retry-After')).toBe('2')
	expect(sent).toEqual([])
	expect(chunks.size).toBe(0)
	expect(queue.depth).toBe(0)
})

test('busy Artifacts is retried inside the queue and never surfaces raw', async () => {
	const { store } = createMemoryStore()
	let clock = 0
	let calls = 0
	const queue = new RepoPushQueue({
		store,
		now: () => clock,
		sleep: async (ms) => {
			clock += ms
		},
		random: () => 0.5,
		fetch: async () => {
			calls += 1
			if (calls < 3) return new Response(busyBody, { status: 409 })
			return new Response('0000unpack ok\n', { status: 200 })
		},
	})
	const response = await queue.handle(pushRequest('pack'))
	expect(response.status).toBe(200)
	expect(await response.text()).toBe('0000unpack ok\n')
	expect(response.headers.get(repoPushQueueAttemptsHeader)).toBe('3')
})

test('in-band HTTP 200 busy (sideband fatal pkt-line) is retried inside the queue', async () => {
	const { store } = createMemoryStore()
	let clock = 0
	let calls = 0
	const inBandBusy = '0025\x03artifacts_git_receive_pack_busy\n'
	const queue = new RepoPushQueue({
		store,
		now: () => clock,
		sleep: async (ms) => {
			clock += ms
		},
		random: () => 0.5,
		fetch: async () => {
			calls += 1
			if (calls < 4) {
				return new Response(inBandBusy, {
					status: 200,
					headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
				})
			}
			return new Response('000eunpack ok\n0000', { status: 200 })
		},
	})
	const response = await queue.handle(pushRequest('pack'))
	expect(response.status).toBe(200)
	const text = await response.text()
	expect(text).toBe('000eunpack ok\n0000')
	expect(text).not.toContain('artifacts_git_receive_pack_busy')
	expect(response.headers.get(repoPushQueueAttemptsHeader)).toBe('4')
})

test('non-fast-forward and other upstream rejections pass through unchanged', async () => {
	const { store } = createMemoryStore()
	const reportStatus = '0000ng refs/heads/main non-fast-forward\n'
	const queue = new RepoPushQueue({
		store,
		fetch: async () =>
			new Response(reportStatus, {
				status: 200,
				headers: {
					'Content-Type': 'application/x-git-receive-pack-result',
				},
			}),
	})
	const response = await queue.handle(pushRequest('pack'))
	expect(response.status).toBe(200)
	expect(await response.text()).toBe(reportStatus)
	expect(response.headers.get('Content-Type')).toBe(
		'application/x-git-receive-pack-result',
	)

	const denied = new RepoPushQueue({
		store,
		fetch: async () => new Response('forbidden', { status: 403 }),
	})
	const deniedResponse = await denied.handle(pushRequest('pack'))
	expect(deniedResponse.status).toBe(403)
	expect(await deniedResponse.text()).toBe('forbidden')
})

test('the 90s budget returns a clean 503 and is checked before every send', async () => {
	const { store, chunks } = createMemoryStore()
	let clock = 0
	const sends: Array<string> = []
	const queue = new RepoPushQueue({
		store,
		now: () => clock,
		sleep: async (ms) => {
			clock += ms
		},
		random: () => 0.999,
		fetch: async (_url, init) => {
			sends.push(await new Response(init.body).text())
			// Another writer holds the Artifacts lock the whole time.
			return new Response(busyBody, { status: 409 })
		},
	})
	const first = queue.handle(pushRequest('first'))
	const second = queue.handle(pushRequest('second'))
	const [firstResponse, secondResponse] = await Promise.all([first, second])

	expect(clock).toBeGreaterThanOrEqual(90_000)
	for (const response of [firstResponse, secondResponse]) {
		expect(response.status).toBe(503)
		expect(response.headers.get('Retry-After')).toBe('2')
		expect(response.headers.get(repoPushQueueOutcomeHeader)).toBe('timeout')
		expect(await response.text()).toBe('repository busy, retry')
	}
	// The second push's turn arrived after its deadline: no send at all.
	expect(sends.every((body) => body === 'first')).toBe(true)
	expect(secondResponse.headers.get(repoPushQueueAttemptsHeader)).toBe('0')
	expect(
		Number(secondResponse.headers.get(repoPushQueueWaitMsHeader)),
	).toBeGreaterThanOrEqual(90_000)
	expect(chunks.size).toBe(0)
})

test('drain: the in-flight push finishes after a new version fences storage; queued and new pushes get a retryable 503', async () => {
	const { store, state } = createMemoryStore()
	const inFlight = deferred()
	const sent: Array<string> = []
	const queue = new RepoPushQueue({
		store,
		fetch: async (_url, init) => {
			const text = await new Response(init.body).text()
			sent.push(text)
			if (text === 'in-flight') await inFlight.promise
			return new Response(`ok ${text}`, { status: 200 })
		},
	})
	const running = queue.handle(pushRequest('in-flight'))
	await settle()
	const queued = queue.handle(pushRequest('queued'))
	await settle()

	// New version takes over: this instance loses storage access.
	state.fenced = true
	const late = await queue.handle(pushRequest('late'))
	expect(late.status).toBe(503)
	expect(late.headers.get(repoPushQueueOutcomeHeader)).toBe('unavailable')

	inFlight.resolve()
	const runningResponse = await running
	expect(runningResponse.status).toBe(200)
	expect(await runningResponse.text()).toBe('ok in-flight')

	const queuedResponse = await queued
	expect(queuedResponse.status).toBe(503)
	expect(queuedResponse.headers.get('Retry-After')).toBe('2')
	expect(sent).toEqual(['in-flight'])
})

test('a new Durable Object instance clears leftovers from a replaced instance', async () => {
	const stored = new Map<string, unknown>([
		['chunk:old:000000', new Uint8Array(1)],
	])
	const blocked: Array<Promise<unknown>> = []
	const storage = {
		deleteAll: async () => stored.clear(),
	} as unknown as DurableObjectStorage
	const ctx = {
		storage,
		blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
			const promise = fn()
			blocked.push(promise)
			return promise
		},
	} as unknown as DurableObjectState
	new RepoPushQueueV1(ctx, {} as never)
	await Promise.all(blocked)
	expect(stored.size).toBe(0)
})

test('packs are chunked under the per-value storage cap and deleted after the push', async () => {
	const { store, chunks, state } = createMemoryStore()
	let received = 0
	const queue = new RepoPushQueue({
		store,
		limits: { chunkBytes: 1024, inMemorySendBytes: 0 },
		fetch: async (_url, init) => {
			received = (await new Response(init.body).arrayBuffer()).byteLength
			return new Response('ok')
		},
	})
	const pack = new Uint8Array(2_560).fill(7)
	const response = await queue.handle(pushRequest(pack))
	expect(response.status).toBe(200)
	expect(received).toBe(2_560)
	expect(state.puts).toBe(3)
	expect(state.maxChunkBytes).toBeLessThanOrEqual(1024)
	expect(chunks.size).toBe(0)
})

test('oversized packs get 413 and a full queue gets a retryable 503', async () => {
	const { store, chunks } = createMemoryStore()
	const queue = new RepoPushQueue({
		store,
		limits: { bodyLimitBytes: 8, chunkBytes: 4, maxEntries: 1 },
		fetch: async () => new Response('ok'),
	})
	const tooLarge = await queue.handle(pushRequest('0123456789'))
	expect(tooLarge.status).toBe(413)
	expect(chunks.size).toBe(0)

	const hold = manualStream()
	const holding = queue.handle(pushRequest(hold.stream))
	await settle()
	const full = await queue.handle(pushRequest('next'))
	expect(full.status).toBe(503)
	expect(full.headers.get(repoPushQueueOutcomeHeader)).toBe('full')
	hold.controller.close()
	expect((await holding).status).toBe(200)
})

test('gateway rejects malformed handoffs and maps a dead Durable Object to a retryable 503', async () => {
	consoleError.mockImplementation(() => {})
	const throwing = {
		idFromName: (name: string) => name,
		get: () => ({
			fetch: async () => {
				throw new Error('Durable Object reset because its code was updated.')
			},
		}),
	} as unknown as DurableObjectNamespace
	const badSource = await routeToRepoPushQueue(
		pushRequest('x', { [repoPushQueueSourceIdHeader]: 'nope' }),
		throwing,
	)
	expect(badSource.status).toBe(400)
	const dead = await routeToRepoPushQueue(pushRequest('x'), throwing)
	expect(dead.status).toBe(503)
	expect(dead.headers.get('Retry-After')).toBe('2')
	expect(dead.headers.get(repoPushQueueOutcomeHeader)).toBe('unavailable')
	expect(String(consoleError.mock.calls[0]?.[0])).toContain(
		'repo-push-queue-stub-failed',
	)
})

test('Durable Object store chunks keys and deletes in batches', async () => {
	const stored = new Map<string, unknown>()
	const deleteCalls: Array<number> = []
	const storage = {
		put: async (key: string, value: unknown) => {
			stored.set(key, value)
		},
		get: async (key: string) => stored.get(key),
		delete: async (keys: Array<string>) => {
			deleteCalls.push(keys.length)
			for (const key of keys) stored.delete(key)
			return keys.length
		},
		sync: async () => {},
	} as unknown as DurableObjectStorage
	const store = createDurableObjectPushQueueStore(storage)
	for (let index = 0; index < 130; index += 1) {
		await store.putChunk('entry', index, new Uint8Array([index % 255]))
	}
	expect((await store.getChunk('entry', 129))?.[0]).toBe(129)
	await store.deleteEntry('entry', 130)
	expect(stored.size).toBe(0)
	expect(deleteCalls).toEqual([128, 2])
})
