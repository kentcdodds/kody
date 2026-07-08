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
