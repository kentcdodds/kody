import { expect, test } from 'vitest'
import {
	getAppBaseUrl,
	getCanonicalAppBaseUrl,
	getPackageAppBaseUrl,
	getPackageAppOriginConfigurationError,
	joinAppUrl,
	parsePackageAppRequestHost,
} from './app-base-url.ts'

test('getAppBaseUrl prefers the request origin when present', () => {
	expect(
		getAppBaseUrl({
			env: { APP_BASE_URL: 'https://heykody.dev' },
			requestUrl: 'https://kody-production.kody-a99.workers.dev/mcp',
		}),
	).toBe('https://kody-production.kody-a99.workers.dev')

	expect(
		getAppBaseUrl({
			env: { APP_BASE_URL: 'https://configured.example' },
			requestUrl: 'https://heykody.dev/mcp',
		}),
	).toBe('https://heykody.dev')
})

test('getAppBaseUrl falls back to APP_BASE_URL then heykody.app, and joinAppUrl strips trailing slashes', () => {
	expect(
		getAppBaseUrl({
			env: { APP_BASE_URL: 'https://configured.example/path' },
		}),
	).toBe('https://configured.example')

	expect(
		getAppBaseUrl({
			env: { APP_BASE_URL: '' },
		}),
	).toBe('https://heykody.app')

	expect(
		getAppBaseUrl({
			env: {},
			requestUrl: null,
		}),
	).toBe('https://heykody.app')

	expect(
		joinAppUrl({
			env: { APP_BASE_URL: 'https://heykody.dev/' },
			path: '/admin/insights',
		}),
	).toBe('https://heykody.dev/admin/insights')
	expect(
		joinAppUrl({
			env: { APP_BASE_URL: 'https://heykody.dev' },
			path: 'admin/users',
		}),
	).toBe('https://heykody.dev/admin/users')
})

test('getCanonicalAppBaseUrl prefers the configured origin over the request origin', () => {
	// A page dual-served from a legacy host must emit canonical URLs on the
	// configured canonical origin, not the host it happened to be served from.
	expect(
		getCanonicalAppBaseUrl({
			env: { APP_BASE_URL: 'https://heykody.app' },
			requestUrl: 'https://heykody.dev/blog',
		}),
	).toBe('https://heykody.app')

	// Local dev and preview leave APP_BASE_URL unset; the request origin is
	// the only origin those deployments can serve.
	expect(
		getCanonicalAppBaseUrl({
			env: {},
			requestUrl: 'http://localhost:3742/blog',
		}),
	).toBe('http://localhost:3742')

	expect(getCanonicalAppBaseUrl({ env: {} })).toBe('https://heykody.app')
})

test('the package-app origin is configurable and never resolves as the app origin', () => {
	expect(getPackageAppBaseUrl({ env: {} })).toBeNull()
	expect(
		getPackageAppBaseUrl({ env: { PACKAGE_APP_BASE_URL: '  ' } }),
	).toBeNull()
	expect(
		getPackageAppBaseUrl({ env: { PACKAGE_APP_BASE_URL: 'not-a-url' } }),
	).toBeNull()
	expect(
		getPackageAppBaseUrl({
			env: { PACKAGE_APP_BASE_URL: 'https://kodyapps.dev/ignored' },
		}),
	).toBe('https://kodyapps.dev')

	// `npm run dev` runs the production Wrangler env, so local dev sees the
	// committed production value and must ignore an origin it cannot serve.
	expect(
		getPackageAppBaseUrl({
			env: {
				PACKAGE_APP_BASE_URL: 'https://kodyapps.dev',
				WRANGLER_IS_LOCAL_DEV: 'true',
			},
		}),
	).toBeNull()
	expect(
		getPackageAppBaseUrl({
			env: {
				PACKAGE_APP_BASE_URL: 'http://packages.localhost:3742',
				WRANGLER_IS_LOCAL_DEV: 'true',
			},
		}),
	).toBe('http://packages.localhost:3742')
	// Only the literal 'true' means local dev, so a stray value cannot pull
	// package apps back onto the app origin in a real deployment.
	for (const localDevFlag of ['false', '0', 'no', ' ']) {
		expect(
			getPackageAppBaseUrl({
				env: {
					PACKAGE_APP_BASE_URL: 'https://kodyapps.dev',
					WRANGLER_IS_LOCAL_DEV: localDevFlag,
				},
			}),
		).toBe('https://kodyapps.dev')
	}

	const env = {
		APP_BASE_URL: 'https://heykody.dev',
		PACKAGE_APP_BASE_URL: 'https://kodyapps.dev',
	}
	// Package runtime callbacks and first-party links resolved while serving a
	// package app must point at the app origin, never at the package-app host —
	// neither the bare origin nor a per-user subdomain.
	expect(
		getAppBaseUrl({ env, requestUrl: 'https://kodyapps.dev/@me/packages/x' }),
	).toBe('https://heykody.dev')
	expect(
		getAppBaseUrl({
			env,
			requestUrl: 'https://user-me.kodyapps.dev/packages/x',
		}),
	).toBe('https://heykody.dev')
	expect(
		getAppBaseUrl({ env, requestUrl: 'https://heykody.dev/@me/packages/x' }),
	).toBe('https://heykody.dev')
})

test('parsePackageAppRequestHost classifies apex, user subdomains, and rejects everything else', () => {
	const env = { PACKAGE_APP_BASE_URL: 'https://kodyapps.dev' }
	const parse = (url: string) =>
		parsePackageAppRequestHost({ env, url: new URL(url) })

	expect(parse('https://kodyapps.dev/anything')).toEqual({ kind: 'apex' })
	expect(parse('https://kentcdodds.kodyapps.dev/packages/demo')).toEqual({
		kind: 'user-subdomain',
		username: 'kentcdodds',
	})
	// Hostnames the wildcard route still delivers, but that no user can own.
	for (const url of [
		// Nested labels.
		'https://a.b.kodyapps.dev/',
		// Not a valid username label (too short / invalid characters).
		'https://xy.kodyapps.dev/',
		'https://bad_label.kodyapps.dev/',
		// Wrong scheme for the configured origin.
		'http://kentcdodds.kodyapps.dev/',
		// Trailing DNS dots resolve to the same host but survive in
		// URL.hostname; letting them fall through would route them first-party.
		'https://kodyapps.dev./',
		'https://kentcdodds.kodyapps.dev./',
	]) {
		expect(parse(url), url).toEqual({ kind: 'unrecognized-subdomain' })
	}
	// Not the package-app domain at all.
	for (const url of [
		'https://heykody.dev/',
		'https://evil-kodyapps.dev/',
		'https://kodyapps.dev.attacker.example/',
		// Same hostname on another scheme/port is another local service.
		'http://kodyapps.dev/',
	]) {
		expect(parse(url), url).toBeNull()
	}
	// No configured package-app origin: nothing classifies.
	expect(
		parsePackageAppRequestHost({
			env: {},
			url: new URL('https://kentcdodds.kodyapps.dev/'),
		}),
	).toBeNull()
})

test('production package-app origin configuration requires a separate registrable domain', () => {
	expect(
		getPackageAppOriginConfigurationError({
			APP_BASE_URL: 'https://heykody.dev',
			SENTRY_ENVIRONMENT: 'preview',
		}),
	).toBeNull()

	expect(
		getPackageAppOriginConfigurationError({
			APP_BASE_URL: 'https://heykody.dev',
			SENTRY_ENVIRONMENT: 'production',
		}),
	).toContain('requires PACKAGE_APP_BASE_URL')

	for (const packageAppBaseUrl of [
		'https://heykody.dev',
		'https://apps.heykody.dev',
	]) {
		expect(
			getPackageAppOriginConfigurationError({
				APP_BASE_URL: 'https://heykody.dev',
				PACKAGE_APP_BASE_URL: packageAppBaseUrl,
				SENTRY_ENVIRONMENT: 'production',
			}),
		).toContain('separate registrable domain')
	}

	expect(
		getPackageAppOriginConfigurationError({
			APP_BASE_URL: 'https://heykody.dev',
			PACKAGE_APP_BASE_URL: 'https://kodyapps.dev',
			SENTRY_ENVIRONMENT: 'production',
		}),
	).toBeNull()
})
