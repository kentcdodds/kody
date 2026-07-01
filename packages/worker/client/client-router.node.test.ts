import { expect, test } from 'vitest'
import { matchRoute } from './client-router.tsx'

test('client route matching uses Remix route-pattern specificity', () => {
	const genericSecretRoute = 'generic-secret-route' as unknown as JSX.Element
	const userSecretRoute = 'user-secret-route' as unknown as JSX.Element
	const routes = {
		'/account/secrets/:secretId': genericSecretRoute,
		'/account/secrets/user/:secretName': userSecretRoute,
	}

	expect(matchRoute('/account/secrets/user/github-token', routes)).toBe(
		userSecretRoute,
	)
	expect(matchRoute('/account/secrets/secret-1', routes)).toBe(
		genericSecretRoute,
	)
})
