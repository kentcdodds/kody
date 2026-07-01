import { expect, test } from 'vitest'
import { matchRoute } from './client-router.tsx'

test('client route matching uses Remix route-pattern specificity', () => {
	const tokenDetailRoute = 'token-detail-route' as unknown as JSX.Element
	const newTokenRoute = 'new-token-route' as unknown as JSX.Element
	const routes = {
		'/account/package-invocation-tokens/:tokenId': tokenDetailRoute,
		'/account/package-invocation-tokens/new': newTokenRoute,
	}

	expect(matchRoute('/account/package-invocation-tokens/new', routes)).toBe(
		newTokenRoute,
	)
	expect(matchRoute('/account/package-invocation-tokens/token-1', routes)).toBe(
		tokenDetailRoute,
	)
})

test('client route matching handles nested static routes over dynamic parents', () => {
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
