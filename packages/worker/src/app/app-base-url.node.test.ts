import { expect, test } from 'vitest'
import { getAppBaseUrl } from './app-base-url.ts'

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
