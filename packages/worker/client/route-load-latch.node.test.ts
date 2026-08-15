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

test('a pending load does not re-queue on later renders for the same href', () => {
	const latch = createRouteLoadLatch()
	// First decision latches pending so a queueTask that aborts itself via
	// handle.update() cannot cascade into the Remix infinite-loop guard.
	expect(
		latch.needsLoad({ ...baseInput, currentHref: '/a', isLoading: true }),
	).toBe(true)
	expect(
		latch.needsLoad({ ...baseInput, currentHref: '/a', isLoading: true }),
	).toBe(false)
	latch.markLoaded('/a')
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(false)
})

test('isLoading alone does not force a load when the href is already loaded', () => {
	const latch = createRouteLoadLatch()
	latch.markLoaded('/a')
	expect(
		latch.needsLoad({ ...baseInput, currentHref: '/a', isLoading: true }),
	).toBe(false)
})

test('clearPending after abort allows the same href to re-queue', () => {
	const latch = createRouteLoadLatch()
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	const attempt = latch.getPendingAttempt()
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(false)
	latch.clearPending('/a', attempt)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
})

test('a stale abort clearPending cannot clear a newer pending attempt', () => {
	const latch = createRouteLoadLatch()
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	const firstAttempt = latch.getPendingAttempt()
	latch.clearPending('/a', firstAttempt)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	const secondAttempt = latch.getPendingAttempt()
	expect(secondAttempt).not.toBe(firstAttempt)
	// Late abort from the first queueTask must leave the second pending intact.
	latch.clearPending('/a', firstAttempt)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(false)
	latch.clearPending('/a', secondAttempt)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
})

test('a stale completion for a previous href does not clear the active pending latch', () => {
	const latch = createRouteLoadLatch()
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/b' })).toBe(true)
	// Late success for /a must not clear /b's pending or steal lastLoaded.
	latch.markLoaded('/a')
	expect(latch.isLoadedFor('/a')).toBe(false)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/b' })).toBe(false)
	latch.markLoaded('/b')
	expect(latch.isLoadedFor('/b')).toBe(true)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/b' })).toBe(false)
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

test('a stale refresh clears an abandoned pending latch for the same href', () => {
	const latch = createRouteLoadLatch()
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(false)
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
