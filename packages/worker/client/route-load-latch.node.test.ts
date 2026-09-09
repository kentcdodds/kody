import { expect, test } from 'vitest'
import { createRouteLoadLatch } from './route-load-latch.ts'

const baseInput = {
	appliedRouteData: false,
	needsStaleRefresh: false,
}

test('pending latch stops re-queue; abort clearPending is attempt-scoped', () => {
	const latch = createRouteLoadLatch()
	// First decision latches pending so a queueTask that aborts itself via
	// handle.update() cannot cascade into the Remix infinite-loop guard.
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(false)
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

test('load, fail, navigate, and stale-refresh workflows share one latch', () => {
	const latch = createRouteLoadLatch()
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	latch.markLoaded('/a')
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(false)
	expect(latch.isLoadedFor('/a')).toBe(true)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(false)

	expect(latch.needsLoad({ ...baseInput, currentHref: '/b' })).toBe(true)
	latch.markLoaded('/b')
	expect(latch.isLoadedFor('/b')).toBe(true)

	// Navigate away before /a completes: late success must not steal lastLoaded
	// or clear the active pending latch.
	const midNav = createRouteLoadLatch()
	expect(midNav.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	expect(midNav.needsLoad({ ...baseInput, currentHref: '/b' })).toBe(true)
	midNav.markLoaded('/a')
	expect(midNav.isLoadedFor('/a')).toBe(false)
	expect(midNav.needsLoad({ ...baseInput, currentHref: '/b' })).toBe(false)
	midNav.markLoaded('/b')
	expect(midNav.isLoadedFor('/b')).toBe(true)

	latch.markFailed('/b')
	expect(latch.needsLoad({ ...baseInput, currentHref: '/b' })).toBe(false)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/b' })).toBe(true)

	latch.markFailed('/b')
	expect(
		latch.needsLoad({
			...baseInput,
			currentHref: '/b',
			needsStaleRefresh: true,
		}),
	).toBe(true)

	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	latch.markLoaded('/a')
	latch.markFailed('/a')
	expect(latch.isLoadedFor('/a')).toBe(false)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/c' })).toBe(true)
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(true)
	// Same location still pending after the re-entry above.
	expect(latch.needsLoad({ ...baseInput, currentHref: '/a' })).toBe(false)
	expect(
		latch.needsLoad({
			...baseInput,
			currentHref: '/a',
			needsStaleRefresh: true,
		}),
	).toBe(true)
})

test('applied route data on a new location is a completed load, so the corrective render does not refetch', () => {
	const latch = createRouteLoadLatch()
	// Full document load of /docs/memory: SSR data applied.
	latch.markLoaded('/docs/memory')
	expect(
		latch.needsLoad({
			...baseInput,
			currentHref: '/docs/memory',
			appliedRouteData: true,
		}),
	).toBe(false)

	// SPA navigation to /docs/secrets: the router preloaded the payload, the
	// route applies it and (as every route does) calls markLoaded before
	// needsLoad — while the latch still thinks the location is /docs/memory.
	latch.markLoaded('/docs/secrets')
	expect(
		latch.needsLoad({
			...baseInput,
			currentHref: '/docs/secrets',
			appliedRouteData: true,
		}),
	).toBe(false)
	expect(latch.isLoadedFor('/docs/secrets')).toBe(true)

	// The consume helper schedules one corrective render with nothing left to
	// apply. It must not queue a fetch for data the route already rendered.
	expect(latch.needsLoad({ ...baseInput, currentHref: '/docs/secrets' })).toBe(
		false,
	)

	// A stale refresh for the same location still forces a real reload.
	expect(
		latch.needsLoad({
			...baseInput,
			currentHref: '/docs/secrets',
			needsStaleRefresh: true,
		}),
	).toBe(true)
})

test('applied route data and in-page hashes do not force a new load', () => {
	const latch = createRouteLoadLatch()
	expect(
		latch.needsLoad({
			...baseInput,
			currentHref: '/a',
			appliedRouteData: true,
		}),
	).toBe(false)

	expect(latch.needsLoad({ ...baseInput, currentHref: '/' })).toBe(true)
	latch.markLoaded('/')
	expect(latch.needsLoad({ ...baseInput, currentHref: '/#invite' })).toBe(false)
	expect(latch.isLoadedFor('/#invite')).toBe(true)
	expect(
		latch.needsLoad({ ...baseInput, currentHref: '/?ref=blog#invite' }),
	).toBe(true)
})
