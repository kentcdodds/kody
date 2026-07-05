import { expect, test, vi } from 'vitest'
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

test('intent prefetch adoption returns in-flight results once and aborts on navigate-away', async () => {
	abortIntentPrefetch()
	const deferred = createDeferredLoader()
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)

	const taken = takePrefetchedRouteResult('/account')
	expect(taken).not.toBeNull()
	expect(takePrefetchedRouteResult('/account')).toBeNull()

	deferred.resolve({ accountProfile: { ok: true } as never })
	await expect(taken).resolves.toEqual({ accountProfile: { ok: true } })

	abortIntentPrefetch()
	const redirectDeferred = createDeferredLoader()
	prefetchRouteOnIntent('/account', redirectDeferred.loader, accountUrl)
	const redirectTaken = takePrefetchedRouteResult('/account')
	redirectDeferred.resolve(routeLoaderRedirect('/login'))
	await expect(redirectTaken).resolves.toEqual(routeLoaderRedirect('/login'))

	abortIntentPrefetch()
	const navigateAway = createDeferredLoader()
	prefetchRouteOnIntent('/account', navigateAway.loader, accountUrl)
	expect(takePrefetchedRouteResult('/account/secrets')).toBeNull()
	expect(navigateAway.calls[0]?.signal.aborted).toBe(true)
	expect(takePrefetchedRouteResult('/account')).toBeNull()

	abortIntentPrefetch()
	const adoptingNavigation = createDeferredLoader()
	prefetchRouteOnIntent('/account', adoptingNavigation.loader, accountUrl)
	const navigation = new AbortController()
	const adopted = takePrefetchedRouteResult('/account', navigation.signal)
	expect(adopted).not.toBeNull()
	adoptingNavigation.calls[0]?.signal.addEventListener('abort', () =>
		adoptingNavigation.reject(new DOMException('aborted', 'AbortError')),
	)
	void adopted?.catch(() => {})
	navigation.abort()
	expect(adoptingNavigation.calls[0]?.signal.aborted).toBe(true)
})

test('intent prefetch reuses in-flight runs, aborts superseded hrefs, and retries after failures', async () => {
	abortIntentPrefetch()
	const deferred = createDeferredLoader()
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)
	expect(deferred.calls).toHaveLength(1)

	abortIntentPrefetch()
	const first = createDeferredLoader()
	prefetchRouteOnIntent('/account', first.loader, accountUrl)
	const second = createDeferredLoader()
	prefetchRouteOnIntent(
		'/account/secrets',
		second.loader,
		new URL('https://kody.local/account/secrets'),
	)
	expect(first.calls[0]?.signal.aborted).toBe(true)
	expect(takePrefetchedRouteResult('/account/secrets')).not.toBeNull()
	expect(takePrefetchedRouteResult('/account')).toBeNull()

	abortIntentPrefetch()
	const failed = createDeferredLoader()
	prefetchRouteOnIntent('/account', failed.loader, accountUrl)
	failed.reject(new Error('network down'))
	await Promise.resolve()
	expect(takePrefetchedRouteResult('/account')).toBeNull()

	const retry = createDeferredLoader()
	prefetchRouteOnIntent('/account', retry.loader, accountUrl)
	expect(retry.calls).toHaveLength(1)
	expect(takePrefetchedRouteResult('/account')).not.toBeNull()
})

test('settled intent prefetches expire and restart on the next intent', async () => {
	abortIntentPrefetch()
	vi.useFakeTimers()
	const deferred = createDeferredLoader()
	prefetchRouteOnIntent('/account', deferred.loader, accountUrl)
	deferred.resolve({})
	await Promise.resolve()

	vi.advanceTimersByTime(maxPrefetchAgeMs + 1)
	expect(takePrefetchedRouteResult('/account')).toBeNull()

	const second = createDeferredLoader()
	prefetchRouteOnIntent('/account', second.loader, accountUrl)
	expect(second.calls).toHaveLength(1)

	abortIntentPrefetch()
	vi.useRealTimers()
})
