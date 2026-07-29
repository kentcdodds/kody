import { expect, test } from 'vitest'
import { clientRouteAreaNameForPath } from '#client/lazy-route.tsx'
import { clientRouteLoaders, clientRoutes } from '#client/routes/index.tsx'
import { oauthPaths } from '#app/oauth-paths.ts'
import { routePattern } from '#app/route-pattern.ts'
import { routes } from '#app/routes.ts'

/**
 * A LazyRoute pattern missing from the preload matcher renders `null` into
 * SSR HTML (queueTask is a no-op on the server), so every route pattern must
 * either be eager or resolve to a registered lazy area.
 */

const eagerPatterns = new Set([
	routePattern(routes.home),
	routePattern(routes.login),
	routePattern(routes.signup),
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

test('lazy area names match the manifest builder contract', () => {
	// Must stay in sync with `lazyAreaNames` in tools/build-client-manifest.ts
	// (tools/build-client-manifest.node.test.ts pins the same literal).
	const expectedAreaNames = [
		'account-area',
		'admin-area',
		'blog-area',
		'community-area',
		'onboarding-area',
	]
	const registeredNames = new Set<string>()
	const samplePaths = [
		'/account',
		'/admin/users',
		'/blog',
		'/community',
		'/@someone',
		'/timeline',
		'/onboarding',
		'/connect/oauth',
		'/oauth/authorize',
	]
	for (const path of samplePaths) {
		const name = clientRouteAreaNameForPath(path)
		if (name) registeredNames.add(name)
	}
	expect([...registeredNames].sort()).toEqual(expectedAreaNames)
})
