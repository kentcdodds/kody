import { expect, test } from 'vitest'
import {
	getAppBaseUrl,
	getPackageAppBaseUrl,
	getPackageAppOriginConfigurationError,
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

test('getAppBaseUrl falls back to APP_BASE_URL then heykody.dev', () => {
	expect(
		getAppBaseUrl({
			env: { APP_BASE_URL: 'https://configured.example/path' },
		}),
	).toBe('https://configured.example')

	expect(
		getAppBaseUrl({
			env: { APP_BASE_URL: '' },
		}),
	).toBe('https://heykody.dev')

	expect(
		getAppBaseUrl({
			env: {},
			requestUrl: null,
		}),
	).toBe('https://heykody.dev')
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
	// package app must point at the app origin, never at the package-app host.
	expect(
		getAppBaseUrl({ env, requestUrl: 'https://kodyapps.dev/@me/packages/x' }),
	).toBe('https://heykody.dev')
	expect(
		getAppBaseUrl({ env, requestUrl: 'https://heykody.dev/@me/packages/x' }),
	).toBe('https://heykody.dev')
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
