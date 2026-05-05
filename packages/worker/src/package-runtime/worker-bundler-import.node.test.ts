import { expect, test } from 'vitest'

test('@cloudflare/worker-bundler main entrypoint imports in node', async () => {
	const workerBundler = await import('@cloudflare/worker-bundler')

	expect(workerBundler.createWorker).toEqual(expect.any(Function))
	expect(workerBundler.createApp).toEqual(expect.any(Function))
})
