import { expect, test } from 'vitest'
import { createMatcher } from 'remix/route-pattern/match'
import { routes } from '#universal/routes.ts'
import { parsePackageAppPath } from '#worker/package-runtime/package-app-serve.ts'
import {
	isNamespacedAppEndpointPath,
	isNamespacedPackageInvocationEndpointPath,
} from './user-namespace-routes.ts'

const communityPackageMatcher = createMatcher(routes.communityPackage.pattern)

test('machine namespaces claim only their multi-segment paths', () => {
	expect(isNamespacedAppEndpointPath('/@kody/packages/devin')).toBe(true)
	expect(isNamespacedAppEndpointPath('/@kody/packages/devin/index.html')).toBe(
		true,
	)
	expect(isNamespacedAppEndpointPath('/@kody/connectors/home')).toBe(true)
	expect(isNamespacedAppEndpointPath('/@kody/webhooks/devin/hook/secret')).toBe(
		true,
	)
	expect(
		isNamespacedPackageInvocationEndpointPath(
			'/@kody/api/package-invocations/abc',
		),
	).toBe(true)

	expect(isNamespacedAppEndpointPath('/community/listing-1')).toBe(false)
	expect(isNamespacedPackageInvocationEndpointPath('/@kody/api')).toBe(false)

	// Including the ids that spell a namespace segment: the two-segment form is
	// the public page, not a truncated machine path.
	for (const pathname of [
		'/@kody/devin',
		'/@kody/packages',
		'/@kody/connectors',
		'/@kody/webhooks',
		'/@kody/api',
	]) {
		expect(isNamespacedAppEndpointPath(pathname)).toBe(false)
		expect(isNamespacedPackageInvocationEndpointPath(pathname)).toBe(false)
		expect(parsePackageAppPath(pathname)).toBeNull()
	}

	expect(parsePackageAppPath('/@kody/packages/devin')).toEqual({
		username: 'kody',
		kodyId: 'devin',
		restPath: '/',
		mount: 'username-path',
	})
	expect(parsePackageAppPath('/@kody/devin')).toBeNull()
	expect(
		isNamespacedAppEndpointPath('/@kody/doom/assets/docs/poster.png'),
	).toBe(false)
	expect(parsePackageAppPath('/@kody/doom/assets/docs/poster.png')).toBeNull()

	expect(
		communityPackageMatcher.match(new URL('https://example.com/@kody/devin'))
			?.params,
	).toEqual({ username: 'kody', kodyId: 'devin' })
	expect(
		communityPackageMatcher.match(
			new URL('https://example.com/@kody/packages/devin'),
		),
	).toBeNull()
})
