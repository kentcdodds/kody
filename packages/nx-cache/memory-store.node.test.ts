import { expect, test } from 'vitest'

import { createMemoryCacheStore } from './memory-store.ts'

const HASH = '0123456789abcdef0123456789abcdef'

test('putIfAbsent rechecks after consuming a streamed body', async () => {
	const store = createMemoryCacheStore()
	const { promise: delayedBytes, resolve: release } =
		Promise.withResolvers<Uint8Array>()
	const delayed = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(await delayedBytes)
			controller.close()
		},
	})

	const pending = store.putIfAbsent(HASH, delayed)
	expect(
		await store.putIfAbsent(HASH, new TextEncoder().encode('winner').buffer),
	).toBe('created')
	release(new TextEncoder().encode('late'))
	expect(await pending).toBe('exists')

	const stored = await store.get(HASH)
	if (!stored) throw new Error('expected stored artifact')
	expect(
		new TextDecoder().decode(new Uint8Array(stored.body as ArrayBuffer)),
	).toBe('winner')
})
