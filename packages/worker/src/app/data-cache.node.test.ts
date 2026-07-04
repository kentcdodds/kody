import { expect, test, vi } from 'vitest'
import {
	buildCommunityDetailListingCacheKey,
	buildCommunityIndexCacheKey,
	getCommunityPublicCacheVersion,
	getOrSetDataCache,
	invalidateCommunityPublicCache,
	peekDataCache,
	resetDataCacheForTests,
	setDataCache,
} from './data-cache.ts'

test('getOrSetDataCache returns miss then hit for the same key', async () => {
	resetDataCacheForTests()
	const load = vi.fn(async () => ({ listings: ['a'] }))

	const first = await getOrSetDataCache({
		key: 'community-index:v0:q=:limit=50',
		load,
	})
	const second = await getOrSetDataCache({
		key: 'community-index:v0:q=:limit=50',
		load,
	})

	expect(first.lookup).toBe('miss')
	expect(second.lookup).toBe('hit')
	expect(load).toHaveBeenCalledTimes(1)
})

test('setDataCache expires entries after ttl', () => {
	resetDataCacheForTests()
	vi.useFakeTimers()
	try {
		vi.setSystemTime(new Date('2026-07-04T00:00:00.000Z'))

		setDataCache('short-lived', 'value', 1_000)
		expect(peekDataCache('short-lived')).toBe('value')

		vi.setSystemTime(new Date('2026-07-04T00:00:01.001Z'))
		expect(peekDataCache('short-lived')).toBeUndefined()
	} finally {
		vi.useRealTimers()
		resetDataCacheForTests()
	}
})

test('invalidateCommunityPublicCache bumps version and clears entries', async () => {
	resetDataCacheForTests()
	const load = vi.fn(async () => ['listing'])
	const keyV0 = buildCommunityIndexCacheKey({ query: '', limit: 50 })

	await getOrSetDataCache({ key: keyV0, load })
	expect(getCommunityPublicCacheVersion()).toBe(0)
	expect(peekDataCache(keyV0)).toEqual(['listing'])

	invalidateCommunityPublicCache()

	expect(getCommunityPublicCacheVersion()).toBe(1)
	expect(peekDataCache(keyV0)).toBeUndefined()

	const keyV1 = buildCommunityIndexCacheKey({ query: '', limit: 50 })
	expect(keyV1).toContain(':v1:')
	const next = await getOrSetDataCache({ key: keyV1, load })
	expect(next.lookup).toBe('miss')
	expect(load).toHaveBeenCalledTimes(2)
})

test('buildCommunityDetailListingCacheKey includes listing id and version', () => {
	resetDataCacheForTests()
	invalidateCommunityPublicCache()
	expect(buildCommunityDetailListingCacheKey('listing-1')).toBe(
		'community-detail-listing:v1:id=listing-1',
	)
})

test('setDataCache sweeps expired entries on write', () => {
	resetDataCacheForTests()
	vi.useFakeTimers()
	try {
		vi.setSystemTime(new Date('2026-07-04T00:00:00.000Z'))

		setDataCache('expired', 'old', 1_000)
		setDataCache('fresh', 'new', 60_000)

		vi.setSystemTime(new Date('2026-07-04T00:00:02.000Z'))
		setDataCache('another', 'value', 60_000)

		expect(peekDataCache('expired')).toBeUndefined()
		expect(peekDataCache('fresh')).toBe('new')
		expect(peekDataCache('another')).toBe('value')
	} finally {
		vi.useRealTimers()
		resetDataCacheForTests()
	}
})

test('setDataCache evicts oldest entries when over max bound', () => {
	resetDataCacheForTests()
	for (let index = 0; index < 257; index += 1) {
		setDataCache(`key-${index}`, index)
	}
	expect(peekDataCache('key-0')).toBeUndefined()
	expect(peekDataCache('key-1')).toBe(1)
	expect(peekDataCache('key-256')).toBe(256)
})
