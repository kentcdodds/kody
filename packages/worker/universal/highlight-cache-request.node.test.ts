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

	const colonLang = await highlightBatchCacheRequest(origin, [
		{ code: ' number = 1', lang: 'ts:const x' },
	])
	const colonCode = await highlightBatchCacheRequest(origin, [
		{ code: 'const x: number = 1', lang: 'ts' },
	])
	expect(colonLang.url).not.toBe(colonCode.url)

	const firstNewlineBatch = await highlightBatchCacheRequest(origin, [
		{ code: 'x\n1::y', lang: '' },
		{ code: 'z', lang: '' },
	])
	const secondNewlineBatch = await highlightBatchCacheRequest(origin, [
		{ code: 'x', lang: '' },
		{ code: 'y\n1::z', lang: '' },
	])
	expect(firstNewlineBatch.url).not.toBe(secondNewlineBatch.url)
})
