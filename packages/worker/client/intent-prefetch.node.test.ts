import { afterEach, expect, test, vi } from 'vitest'
import {
	abortIntentPrefetch,
	maxPrefetchAgeMs,
	prefetchRouteOnIntent,
	takePrefetchedRouteResult,
} from './intent-prefetch.ts'
import { type RouteLoader, routeLoaderRedirect } from './route-loader.ts'

function createDeferredLoader() {
	let resolve!: (value: Awaited<ReturnType<RouteLoader>>) => void
	let reject!: (reason: unknown) => void
	const calls: Array<{ url: URL; signal: AbortSignal }> = []
	const loader: RouteLoader = (url, signal) => {
		calls.push({ url, signal })
		return new Promise((res, rej) => {
			resolve = res
			reject = rej
		})
	}
	return {
		loader,
		calls,
		resolve: (value: Awaited<ReturnType<RouteLoader>>) => resolve(value),
		reject: (reason: unknown) => reject(reason),
	}
}

const accountUrl = new URL('https://kody.local/account')

afterEach(() => {
	abortIntentPrefetch()
	vi.useRealTimers()
})

test('takePrefetchedRouteResult returns the in-flight promise once', async () => {
	const deferred = createDeferredLoader()
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)

	const taken = takePrefetchedRouteResult('/account')
	expect(taken).not.toBeNull()
	expect(takePrefetchedRouteResult('/account')).toBeNull()

	deferred.resolve({ accountProfile: { ok: true } as never })
	await expect(taken).resolves.toEqual({ accountProfile: { ok: true } })
})

test('navigating elsewhere aborts and clears the prefetch slot', () => {
	const deferred = createDeferredLoader()
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)

	// A navigation to a different destination consumes nothing but must
	// invalidate the speculative result so a later navigation to /account
	// cannot adopt data prefetched before the user went elsewhere.
	expect(takePrefetchedRouteResult('/account/secrets')).toBeNull()
	expect(deferred.calls[0]?.signal.aborted).toBe(true)
	expect(takePrefetchedRouteResult('/account')).toBeNull()
})

test('repeat intent for the same href reuses the in-flight run', () => {
	const deferred = createDeferredLoader()
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)

	expect(deferred.calls).toHaveLength(1)
})

test('intent for a different href aborts the previous prefetch', () => {
	const first = createDeferredLoader()
	prefetchRouteOnIntent('/account', first.loader, accountUrl)

	const second = createDeferredLoader()
	prefetchRouteOnIntent(
		'/account/secrets',
		second.loader,
		new URL('https://kody.local/account/secrets'),
	)

	expect(first.calls[0]?.signal.aborted).toBe(true)
	// Consume the fresh prefetch first; taking a mismatched href clears the
	// slot, so the stale href is checked after.
	expect(takePrefetchedRouteResult('/account/secrets')).not.toBeNull()
	expect(takePrefetchedRouteResult('/account')).toBeNull()
})

test('failed prefetches are not adopted so navigations retry the loader', async () => {
	const deferred = createDeferredLoader()
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)
	deferred.reject(new Error('network down'))
	await Promise.resolve()

	expect(takePrefetchedRouteResult('/account')).toBeNull()
})

test('failed prefetches allow a fresh run on the next intent', async () => {
	const first = createDeferredLoader()
	prefetchRouteOnIntent('/account', first.loader, accountUrl)
	first.reject(new Error('network down'))
	await Promise.resolve()

	const second = createDeferredLoader()
	prefetchRouteOnIntent('/account', second.loader, accountUrl)
	expect(second.calls).toHaveLength(1)
	expect(takePrefetchedRouteResult('/account')).not.toBeNull()
})

test('settled prefetches expire after maxPrefetchAgeMs', async () => {
	vi.useFakeTimers()
	const deferred = createDeferredLoader()
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)
	deferred.resolve({})
	await Promise.resolve()

	vi.advanceTimersByTime(maxPrefetchAgeMs + 1)
	expect(takePrefetchedRouteResult('/account')).toBeNull()
})

test('expired prefetches restart on the next intent for the same href', async () => {
	vi.useFakeTimers()
	const first = createDeferredLoader()
	prefetchRouteOnIntent('/account', first.loader, accountUrl)
	first.resolve({})
	await Promise.resolve()

	vi.advanceTimersByTime(maxPrefetchAgeMs + 1)
	const second = createDeferredLoader()
	prefetchRouteOnIntent('/account', second.loader, accountUrl)
	expect(second.calls).toHaveLength(1)
})

test('aborting the adopting navigation aborts the underlying prefetch', () => {
	const deferred = createDeferredLoader()
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)

	const navigation = new AbortController()
	const taken = takePrefetchedRouteResult('/account', navigation.signal)
	expect(taken).not.toBeNull()
	// Swallow the eventual AbortError rejection from the loader promise.
	deferred.calls[0]?.signal.addEventListener('abort', () =>
		deferred.reject(new DOMException('aborted', 'AbortError')),
	)
	void taken?.catch(() => {})

	navigation.abort()
	expect(deferred.calls[0]?.signal.aborted).toBe(true)
})

test('redirect results flow through prefetch adoption', async () => {
	const deferred = createDeferredLoader()
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)
	const taken = takePrefetchedRouteResult('/account')
	deferred.resolve(routeLoaderRedirect('/login'))

	await expect(taken).resolves.toEqual(routeLoaderRedirect('/login'))
})
