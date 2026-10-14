import { expect, test } from 'vitest'
import {
	acquireReceivePackGate,
	artifactsReceivePackBusyBackoffMs,
	computeReceivePackBusyBackoffMs,
	readReceivePackBodyWithLimit,
	ReceivePackBodyTooLargeError,
	ReceivePackWaitTimeoutError,
	releaseReceivePackGate,
	waitOutReceivePackBusy,
	withReceivePackGate,
} from './artifacts-receive-pack-wait.ts'

test('FIFO gate runs waiters in arrival order', async () => {
	const key = `fifo-${crypto.randomUUID()}`
	const order: Array<string> = []
	let releaseFirst!: () => void
	const firstHold = new Promise<void>((resolve) => {
		releaseFirst = resolve
	})

	const first = withReceivePackGate(key, 5_000, async () => {
		order.push('a-start')
		await firstHold
		order.push('a-end')
		return 'a'
	})
	// Ensure A holds before B/C enqueue.
	await Promise.resolve()
	const second = withReceivePackGate(key, 5_000, async () => {
		order.push('b')
		return 'b'
	})
	const third = withReceivePackGate(key, 5_000, async () => {
		order.push('c')
		return 'c'
	})

	releaseFirst()
	await expect(Promise.all([first, second, third])).resolves.toEqual([
		'a',
		'b',
		'c',
	])
	expect(order).toEqual(['a-start', 'a-end', 'b', 'c'])
})

test('FIFO gate times out waiters that never get a turn', async () => {
	const key = `timeout-${crypto.randomUUID()}`
	await acquireReceivePackGate(key, 1_000)
	try {
		await expect(acquireReceivePackGate(key, 20)).rejects.toBeInstanceOf(
			ReceivePackWaitTimeoutError,
		)
	} finally {
		releaseReceivePackGate(key)
	}
})

test('busy wait retries until a non-busy response', async () => {
	const sleeps: Array<number> = []
	let attempts = 0
	const result = await waitOutReceivePackBusy({
		deadlineMs: Date.now() + 10_000,
		backoffMs: [5, 5],
		random: () => 1,
		sleep: async (ms) => {
			sleeps.push(ms)
		},
		send: async () => {
			attempts += 1
			if (attempts < 3) {
				return new Response('remote: artifacts_git_receive_pack_busy\n', {
					status: 500,
				})
			}
			return new Response('000eunpack ok\n0000', { status: 200 })
		},
		isBusy: (response, bodyText) =>
			response.status >= 300 &&
			bodyText.includes('artifacts_git_receive_pack_busy'),
		readBusyBody: async (response) => response.text(),
	})
	expect(result.kind).toBe('response')
	if (result.kind === 'response') {
		expect(result.response.status).toBe(200)
		expect(await result.response.text()).toBe('000eunpack ok\n0000')
	}
	expect(attempts).toBe(3)
	expect(sleeps.length).toBe(2)
})

test('busy wait returns timeout when the budget is exhausted', async () => {
	let now = 1_000
	const result = await waitOutReceivePackBusy({
		deadlineMs: 1_050,
		backoffMs: [100],
		random: () => 1,
		now: () => now,
		sleep: async (ms) => {
			now += ms
		},
		send: async () =>
			new Response('remote: artifacts_git_receive_pack_busy\n', {
				status: 500,
			}),
		isBusy: (_response, bodyText) =>
			bodyText.includes('artifacts_git_receive_pack_busy'),
		readBusyBody: async (response) => response.text(),
	})
	expect(result).toEqual({ kind: 'timeout' })
})

test('busy wait does not retry unrelated upstream errors', async () => {
	let attempts = 0
	const result = await waitOutReceivePackBusy({
		deadlineMs: Date.now() + 10_000,
		send: async () => {
			attempts += 1
			return new Response('internal blowup', { status: 500 })
		},
		isBusy: () => false,
		readBusyBody: async (response) => response.text(),
	})
	expect(attempts).toBe(1)
	expect(result.kind).toBe('response')
	if (result.kind === 'response') {
		expect(result.response.status).toBe(500)
		expect(await result.response.text()).toBe('internal blowup')
	}
})

test('full jitter backoff stays within the configured step', () => {
	expect(computeReceivePackBusyBackoffMs(0, [100], () => 0)).toBe(0)
	expect(computeReceivePackBusyBackoffMs(0, [100], () => 1)).toBe(100)
	expect(
		computeReceivePackBusyBackoffMs(
			99,
			artifactsReceivePackBusyBackoffMs,
			() => 1,
		),
	).toBe(artifactsReceivePackBusyBackoffMs.at(-1))
})

test('body reader enforces the buffer limit', async () => {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(100))
			controller.enqueue(new Uint8Array(100))
			controller.close()
		},
	})
	await expect(
		readReceivePackBodyWithLimit(stream, 150),
	).rejects.toBeInstanceOf(ReceivePackBodyTooLargeError)
})

test('body reader returns an empty buffer for a null body', async () => {
	await expect(readReceivePackBodyWithLimit(null)).resolves.toEqual(
		new Uint8Array(),
	)
})

test('withReceivePackGate releases after a thrown fn', async () => {
	const key = `release-${crypto.randomUUID()}`
	await expect(
		withReceivePackGate(key, 1_000, async () => {
			throw new Error('boom')
		}),
	).rejects.toThrow('boom')
	await expect(withReceivePackGate(key, 1_000, async () => 'ok')).resolves.toBe(
		'ok',
	)
})
