import { expect, test } from 'vitest'
import {
	matchRoute,
	matchRouteLoader,
	type RouteLoader,
} from './client-router.tsx'

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

test('route loader matching uses the same route-pattern specificity', () => {
	const accountLoader = (async () => ({
		accountProfile: { ok: true },
	})) as RouteLoader
	const tokenLoader = (async () => ({
		accountPackageInvocationTokens: { ok: true },
	})) as RouteLoader
	const loaders = {
		'/account/package-invocation-tokens/:tokenId': tokenLoader,
		'/account/package-invocation-tokens/new': tokenLoader,
		'/account': accountLoader,
	}

	expect(matchRouteLoader('/account', loaders)).toBe(accountLoader)
	expect(
		matchRouteLoader('/account/package-invocation-tokens/new', loaders),
	).toBe(tokenLoader)
	expect(
		matchRouteLoader('/account/package-invocation-tokens/token-1', loaders),
	).toBe(tokenLoader)
})

test('route loader matching prefers nested static routes over dynamic parents', () => {
	const genericSecretLoader = (async () => ({
		accountSecrets: { ok: true },
	})) as RouteLoader
	const userSecretLoader = (async () => ({
		accountSecrets: { ok: true },
	})) as RouteLoader
	const loaders = {
		'/account/secrets/:secretId': genericSecretLoader,
		'/account/secrets/user/:secretName': userSecretLoader,
	}

	expect(matchRouteLoader('/account/secrets/user/github-token', loaders)).toBe(
		userSecretLoader,
	)
	expect(matchRouteLoader('/account/secrets/secret-1', loaders)).toBe(
		genericSecretLoader,
	)
})
