import { expect, test } from 'vitest'
import { type Handle } from 'remix/ui'
import {
	AppLoaderDataProvider,
	hrefMatchesSsrUrl,
	normalizeRouterHref,
	tryConsumeRouteLoaderData,
} from './loader-data-context.tsx'
import {
	clearPreloadedNavigationData,
	setPreloadedNavigationData,
} from './navigation-data.ts'

test('loader href helpers normalize URLs and compare pathname and search', () => {
	expect(normalizeRouterHref('/community?q=beta')).toBe('/community?q=beta')
	expect(normalizeRouterHref('https://kody.local/community?q=beta#top')).toBe(
		'/community?q=beta',
	)
	expect(hrefMatchesSsrUrl('/#invite', '/')).toBe(true)

	expect(hrefMatchesSsrUrl('/community?q=beta', '/community?q=beta')).toBe(true)
	expect(
		hrefMatchesSsrUrl(
			'https://kody.local/community?q=beta',
			'/community?q=beta',
		),
	).toBe(true)
	expect(hrefMatchesSsrUrl('/community?q=beta', '/community')).toBe(false)
	expect(hrefMatchesSsrUrl('/community', '/community?q=beta')).toBe(false)
	expect(
		hrefMatchesSsrUrl(
			'/account/package-invocation-tokens/token-1',
			'/account/package-invocation-tokens/token-1',
		),
	).toBe(true)
	expect(
		hrefMatchesSsrUrl(
			'/account/package-invocation-tokens/token-2',
			'/account/package-invocation-tokens/token-1',
		),
	).toBe(false)
})

function createStubHandle() {
	const queuedTasks: Array<(signal?: AbortSignal) => unknown> = []
	let updateCount = 0
	const handle = {
		context: {
			get(provider: unknown) {
				if (provider === AppLoaderDataProvider) {
					return { loaderData: undefined, consumedKeys: new Set() }
				}
				// No RouterLocationProvider in the stub tree; consumption
				// falls through to the preloaded navigation slot.
				throw new Error('context not available')
			},
		},
		queueTask(task: (signal?: AbortSignal) => unknown) {
			queuedTasks.push(task)
		},
		update() {
			updateCount++
			return Promise.resolve(new AbortController().signal)
		},
	} as unknown as Handle
	return {
		handle,
		queuedTasks,
		getUpdateCount: () => updateCount,
	}
}

test('consuming route loader data schedules a corrective re-render exactly once', () => {
	clearPreloadedNavigationData()
	setPreloadedNavigationData('/account', {
		accountProfile: {
			ok: true,
			email: 'kody@example.com',
			emailVerified: true,
			username: 'kody',
			displayName: 'Kody',
		},
	})
	const { handle, queuedTasks, getUpdateCount } = createStubHandle()

	// Routes apply consumed payloads by mutating closure state mid-render, so
	// a follow-up render must be scheduled or derivations made before the
	// consume call would persist stale.
	const consumed = tryConsumeRouteLoaderData(
		handle,
		'accountProfile',
		'/account',
	)
	expect(consumed?.email).toBe('kody@example.com')
	expect(queuedTasks).toHaveLength(1)
	for (const task of queuedTasks.splice(0)) task()
	expect(getUpdateCount()).toBe(1)

	// Consume-once: the follow-up render finds nothing and schedules nothing,
	// so the corrective render cannot loop.
	const reconsumed = tryConsumeRouteLoaderData(
		handle,
		'accountProfile',
		'/account',
	)
	expect(reconsumed).toBeUndefined()
	expect(queuedTasks).toHaveLength(0)
	expect(getUpdateCount()).toBe(1)

	clearPreloadedNavigationData()
})
