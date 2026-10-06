import { expect, test, vi } from 'vitest'
import {
	buildCommunityDetailListingCacheKey,
	buildCommunityIndexCacheKey,
	getCommunityPublicCacheVersion,
	getOrSetDataCache,
	invalidateCommunityPublicCache,
	peekDataCache,
	setDataCache,
} from './data-cache.ts'

const indexKeyInput = {
	query: '',
	sort: 'best',
	limit: 50,
	category: null,
	overview: true,
} as const

test('getOrSetDataCache returns miss then hit for the same key', async () => {
	invalidateCommunityPublicCache()
	const key = buildCommunityIndexCacheKey(indexKeyInput)
	const load = vi.fn(async () => ({ listings: ['a'] }))

	const first = await getOrSetDataCache({
		key,
		load,
	})
	const second = await getOrSetDataCache({
		key,
		load,
	})

	expect(first.lookup).toBe('miss')
	expect(second.lookup).toBe('hit')
	expect(load).toHaveBeenCalledTimes(1)
})

test('setDataCache expires entries after ttl', () => {
	invalidateCommunityPublicCache()
	vi.useFakeTimers()
	try {
		vi.setSystemTime(new Date('2026-07-04T00:00:00.000Z'))

		setDataCache('short-lived', 'value', 1_000)
		expect(peekDataCache('short-lived')).toBe('value')

		vi.setSystemTime(new Date('2026-07-04T00:00:01.001Z'))
		expect(peekDataCache('short-lived')).toBeUndefined()
	} finally {
		vi.useRealTimers()
		invalidateCommunityPublicCache()
	}
})

test('invalidateCommunityPublicCache bumps version and clears entries', async () => {
	invalidateCommunityPublicCache()
	const load = vi.fn(async () => ['listing'])
	const versionBefore = getCommunityPublicCacheVersion()
	const keyBefore = buildCommunityIndexCacheKey(indexKeyInput)

	await getOrSetDataCache({ key: keyBefore, load })
	expect(getCommunityPublicCacheVersion()).toBe(versionBefore)
	expect(peekDataCache(keyBefore)).toEqual(['listing'])

	invalidateCommunityPublicCache()

	expect(getCommunityPublicCacheVersion()).toBe(versionBefore + 1)
	expect(peekDataCache(keyBefore)).toBeUndefined()

	const keyAfter = buildCommunityIndexCacheKey(indexKeyInput)
	expect(keyAfter).toContain(`:v${versionBefore + 1}:`)
	const next = await getOrSetDataCache({ key: keyAfter, load })
	expect(next.lookup).toBe('miss')
	expect(load).toHaveBeenCalledTimes(2)
})

test('buildCommunityDetailListingCacheKey includes listing id and version', () => {
	invalidateCommunityPublicCache()
	const version = getCommunityPublicCacheVersion()
	expect(buildCommunityDetailListingCacheKey('listing-1')).toBe(
		`community-detail-listing:v${version}:id=listing-1`,
	)
})

test('setDataCache sweeps expired entries on write', () => {
	invalidateCommunityPublicCache()
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
		invalidateCommunityPublicCache()
	}
})

test('setDataCache evicts oldest entries when over max bound', () => {
	invalidateCommunityPublicCache()
	for (let index = 0; index < 257; index += 1) {
		setDataCache(`key-${index}`, index)
	}
	expect(peekDataCache('key-0')).toBeUndefined()
	expect(peekDataCache('key-1')).toBe(1)
	expect(peekDataCache('key-256')).toBe(256)
})
