import { expect, test } from 'vitest'
import { createRouteLoadLatch } from './route-load-latch.ts'

const baseInput = {
	isLoading: false,
	appliedRouteData: false,
	needsStaleRefresh: false,
}

test('loads once and stays idle for the same href after success', () => {
	const latch = createRouteLoadLatch()
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	latch.markLoaded('/a')
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(false)
	expect(latch.isLoadedFor('/a')).toBe(true)
})

test('a failed load does not re-queue in a loop but retries after navigation', () => {
	const latch = createRouteLoadLatch()
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	latch.markFailed('/a')
	// Same location: the failure latch prevents a tight retry loop.
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(false)
	// Navigating away and back must allow a fresh attempt.
	expect(latch.needsLoad({ ...baseInput, currentHref: '/b' })).toBe(true)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
})

test('location changes and stale refreshes trigger loads', () => {
	const latch = createRouteLoadLatch()
	latch.markLoaded('/a')
	expect(latch.needsLoad({ ...baseInput, currentHref: '/b' })).toBe(true)
	expect(
		latch.needsLoad({
			...baseInput,
			currentHref: '/a',
			needsStaleRefresh: true,
		}),
	).toBe(true)
})

test('a stale refresh overrides a prior failure for the same href', () => {
	const latch = createRouteLoadLatch()
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	latch.markFailed('/a')
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(false)
	// A same-path reload whose loader failed signals staleness once; that
	// user-driven refresh must not be blocked by the failure latch.
	expect(
		latch.needsLoad({
			...baseInput,
			currentHref: '/a',
			needsStaleRefresh: true,
		}),
	).toBe(true)
})

test('a failed refresh invalidates an earlier success for the same href', () => {
	const latch = createRouteLoadLatch()
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	latch.markLoaded('/a')
	// A later refresh for the same location fails; leaving and returning must
	// refetch instead of trusting the stale earlier success.
	latch.markFailed('/a')
	expect(latch.needsLoad({ ...baseInput, currentHref: '/b' })).toBe(true)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	expect(latch.isLoadedFor('/a')).toBe(false)
})

test('applied route loader data suppresses the fallback fetch', () => {
	const latch = createRouteLoadLatch()
	expect(
		latch.needsLoad({
			...baseInput,
			currentHref: '/a',
			appliedRouteData: true,
		}),
	).toBe(false)
})

test('in-page hashes are the same data location as pathname plus search', () => {
	const latch = createRouteLoadLatch()
	expect(latch.needsLoad({ ...baseInput, currentHref: '/' })).toBe(true)
	latch.markLoaded('/')
	expect(latch.needsLoad({ ...baseInput, currentHref: '/#invite' })).toBe(false)
	expect(latch.isLoadedFor('/#invite')).toBe(true)
	expect(
		latch.needsLoad({ ...baseInput, currentHref: '/?ref=blog#invite' }),
	).toBe(true)
})
