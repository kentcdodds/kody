import { expect, test } from 'vitest'
import { parsePackageAppPath } from '#worker/package-runtime/package-app-serve.ts'
import { parseUserScopedConnectorRoutePath } from '#worker/remote-connector/connector-session-key.ts'
import {
	isNamespacedAppEndpointPath,
	isNamespacedPackageInvocationEndpointPath,
} from './user-namespace-routes.ts'

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
		expect(parseUserScopedConnectorRoutePath(pathname)).toBeNull()
	}
})
