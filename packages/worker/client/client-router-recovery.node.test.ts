import { consoleError } from '#worker/test-support/console-spies.ts'
import { expect, test, vi } from 'vitest'

const lazyRouteMocks = vi.hoisted(() => {
	let preloadCallCount = 0
	let rejectRetry: ((reason?: unknown) => void) | null = null
	const preloadClientRouteModules = vi.fn(() => {
		preloadCallCount++
		if (preloadCallCount === 1) {
			return Promise.reject(new Error('first chunk failure'))
		}
		return new Promise<void>((_resolve, reject) => {
			rejectRetry = reject
		})
	})

	return {
		preloadClientRouteModules,
		failRetry() {
			if (!rejectRetry) throw new Error('Chunk retry has not started')
			rejectRetry(new Error('second chunk failure'))
		},
	}
})

vi.mock('./lazy-route.tsx', () => ({
	isClientRouteModuleCached: () => false,
	listenToLazyRouteLoads: () => {},
	preloadClientRouteModules: lazyRouteMocks.preloadClientRouteModules,
}))

import { navigate, registerRouteLoaders } from './client-router.tsx'

test('a loader error waits for chunk retry failure before recovering with full navigation', async () => {
	const previousWindow = globalThis.window
	const assign = vi.fn<() => void>()
	const pushState = vi.fn<() => void>()
	globalThis.window = {
		history: { pushState },
		location: {
			href: 'https://kody.local/',
			origin: 'https://kody.local',
			pathname: '/',
			search: '',
			hash: '',
			assign,
		},
	} as unknown as Window & typeof globalThis
	consoleError.mockImplementation(() => {})
	registerRouteLoaders({
		'/lazy': async () => {
			throw new Error('loader failed')
		},
	})

	try {
		navigate('/lazy')
		await vi.waitFor(() => {
			expect(lazyRouteMocks.preloadClientRouteModules).toHaveBeenCalledTimes(2)
		})

		expect(pushState).not.toHaveBeenCalled()
		expect(assign).not.toHaveBeenCalled()

		lazyRouteMocks.failRetry()
		await vi.waitFor(() => {
			expect(assign).toHaveBeenCalledWith('/lazy')
		})

		expect(pushState).not.toHaveBeenCalled()
		expect(consoleError).toHaveBeenCalledWith(
			'Route chunk preload failed:',
			expect.any(Error),
		)
	} finally {
		registerRouteLoaders({})
		globalThis.window = previousWindow
	}
})
