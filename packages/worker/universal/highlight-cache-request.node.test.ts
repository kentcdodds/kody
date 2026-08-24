import { expect, test } from 'vitest'
import { highlightBatchCacheRequest } from './highlight-cache-request.ts'

test('highlight cache keys are GET URLs that differ by snippet identity', async () => {
	const origin = 'https://highlight-cache.local'
	const first = await highlightBatchCacheRequest(origin, [
		{ code: 'const x = 1', lang: 'ts' },
	])
	const same = await highlightBatchCacheRequest(origin, [
		{ code: 'const x = 1', lang: 'ts' },
	])
	const other = await highlightBatchCacheRequest(origin, [
		{ code: 'const y = 2', lang: 'ts' },
	])

	expect(first.method).toBe('GET')
	expect(first.url).toMatch(
		/^https:\/\/highlight-cache\.local\/batch\/[0-9a-f]{64}$/,
	)
	expect(same.url).toBe(first.url)
	expect(other.url).not.toBe(first.url)
	expect(other.method).toBe('GET')
})
