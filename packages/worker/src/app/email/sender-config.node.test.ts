import { expect, test } from 'vitest'
import { resolveTransactionalEmailConfig } from './sender-config.ts'

test('resolveTransactionalEmailConfig follows the worker origin and remaps leftover heykody hosts', () => {
	expect(
		resolveTransactionalEmailConfig({
			env: {
				APP_BASE_URL: 'https://kody.codes',
				SYSTEM_EMAIL_DOMAIN: 'kody.codes',
			},
		}),
	).toEqual({
		appBaseUrl: 'https://kody.codes',
		fromEmail: 'kody@kody.codes',
	})

	expect(
		resolveTransactionalEmailConfig({
			env: { APP_BASE_URL: 'https://heykody.app/' },
		}),
	).toEqual({
		appBaseUrl: 'https://kody.codes',
		fromEmail: 'kody@kody.codes',
	})

	expect(
		resolveTransactionalEmailConfig({
			env: {
				APP_BASE_URL: 'https://heykody.dev',
				SYSTEM_EMAIL_DOMAIN: 'kody.codes',
			},
			requestUrl: 'https://heykody.dev/signup',
		}),
	).toEqual({
		appBaseUrl: 'https://kody.codes',
		fromEmail: 'kody@kody.codes',
	})

	expect(
		resolveTransactionalEmailConfig({
			env: {
				APP_BASE_URL: 'https://kody-pr-1708.example.workers.dev',
				SYSTEM_EMAIL_DOMAIN: 'kody.codes',
			},
		}),
	).toEqual({
		appBaseUrl: 'https://kody-pr-1708.example.workers.dev',
		fromEmail: 'kody@kody.codes',
	})

	expect(
		resolveTransactionalEmailConfig({
			env: { APP_BASE_URL: 'https://app.example.com/path' },
		}),
	).toEqual({
		appBaseUrl: 'https://app.example.com',
		fromEmail: 'kody@app.example.com',
	})

	expect(
		resolveTransactionalEmailConfig({
			env: {
				WRANGLER_IS_LOCAL_DEV: 'true',
				SYSTEM_EMAIL_DOMAIN: 'kody.codes',
			},
			requestUrl: 'http://localhost:3742/signup',
		}),
	).toEqual({
		appBaseUrl: 'http://localhost:3742',
		fromEmail: 'kody@kody.codes',
	})

	expect(
		resolveTransactionalEmailConfig({
			env: {
				WRANGLER_IS_LOCAL_DEV: 'true',
				APP_BASE_URL: 'https://kody.codes',
				SYSTEM_EMAIL_DOMAIN: 'kody.codes',
			},
			requestUrl: 'http://localhost:3742/signup',
		}),
	).toEqual({
		appBaseUrl: 'http://localhost:3742',
		fromEmail: 'kody@kody.codes',
	})

	expect(
		resolveTransactionalEmailConfig({
			env: { APP_BASE_URL: 'http://localhost:3742' },
		}),
	).toEqual({
		appBaseUrl: 'http://localhost:3742',
		fromEmail: 'kody@localhost',
	})

	expect(resolveTransactionalEmailConfig({ env: {} })).toBeNull()
})
