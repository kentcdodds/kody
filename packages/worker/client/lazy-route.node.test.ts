import { expect, test, vi } from 'vitest'
import {
	clientRouteAreaNameForPath,
	createLazyRoute,
	createLazyRouteArea,
} from '#client/lazy-route.tsx'
import { clientRouteLoaders, clientRoutes } from '#client/routes/index.tsx'
import { oauthPaths } from '#universal/oauth-paths.ts'
import { routePattern } from '#universal/route-pattern.ts'
import { routes } from '#universal/routes.ts'

/**
 * A LazyRoute pattern missing from the preload matcher renders `null` into
 * SSR HTML (queueTask is a no-op on the server), so every route pattern must
 * either be eager or resolve to a registered lazy area.
 */

const eagerPatterns = new Set([
	routePattern(routes.home),
	routePattern(routes.login),
	routePattern(routes.signup),
	routePattern(routes.pricing),
	routePattern(routes.privacy),
	routePattern(routes.terms),
	routePattern(routes.resetPassword),
	routePattern(routes.verify),
	routePattern(routes.verifyEmail),
	routePattern(routes.verifyEmailChange),
	routePattern(routes.pendingVerification),
	oauthPaths.callback,
])

function concretePathForPattern(pattern: string) {
	return pattern
		.split('/')
		.map((segment) => {
			if (segment.startsWith(':')) return 'sample'
			if (segment === '*') return 'sample'
			return segment
		})
		.join('/')
}

test('every non-eager route pattern resolves to a registered lazy area', () => {
	const patterns = new Set([
		...Object.keys(clientRoutes),
		...Object.keys(clientRouteLoaders),
	])
	for (const pattern of patterns) {
		const areaName = clientRouteAreaNameForPath(concretePathForPattern(pattern))
		if (eagerPatterns.has(pattern)) {
			expect(areaName, `eager pattern ${pattern}`).toBeNull()
		} else {
			expect(
				areaName,
				`lazy pattern ${pattern} must be registered`,
			).not.toBeNull()
		}
	}
})

test('a cold lazy route renders a fallback and retries once before full navigation recovery', async () => {
	vi.useFakeTimers()
	const previousWindow = globalThis.window
	const assign = vi.fn()
	globalThis.window = {
		location: {
			pathname: '/community',
			search: '?q=tools',
			hash: '#results',
			assign,
		},
	} as unknown as Window & typeof globalThis

	try {
		const loadModule = vi.fn<() => Promise<{ value: JSX.Element }>>()
		loadModule.mockRejectedValue(new Error('chunk unavailable'))
		const area = createLazyRouteArea(loadModule)
		let queuedTask: ((signal: AbortSignal) => Promise<void> | void) | undefined
		const update = vi.fn()
		const LazyRoute = createLazyRoute(area)
		const render = LazyRoute({
			props: {
				render: (module) => module.value,
			},
			queueTask(task) {
				queuedTask = task
			},
			update,
		} as never)

		expect(render()).not.toBeNull()
		expect(queuedTask).toBeTypeOf('function')

		await queuedTask?.(new AbortController().signal)

		expect(loadModule).toHaveBeenCalledTimes(2)
		expect(assign).toHaveBeenCalledWith('/community?q=tools#results')
	} finally {
		vi.clearAllTimers()
		vi.useRealTimers()
		globalThis.window = previousWindow
	}
})
