import { expect, test } from 'vitest'
import { type Handle } from 'remix/ui'
import {
	readRouterPathname,
	readRouterSearch,
	readRouterUrl,
	readSsrRouterUrl,
	RouterLocationProvider,
} from './router-location.tsx'

function stubHandle(location: unknown) {
	return {
		context: {
			get(provider: unknown) {
				if (provider === RouterLocationProvider) return location
				return undefined
			},
		},
	} as Pick<Handle, 'context'>
}

test('readRouterUrl uses provider context and falls back when HMR drops it', () => {
	const previousWindow = globalThis.window
	expect(readRouterUrl(stubHandle({ url: '/account', ssrUrl: '/' }))).toBe(
		'/account',
	)
	expect(readSsrRouterUrl(stubHandle({ url: '/account', ssrUrl: '/' }))).toBe(
		'/',
	)
	expect(readRouterUrl(stubHandle(undefined))).toBe('/')
	expect(readSsrRouterUrl(stubHandle(undefined))).toBe('/')

	globalThis.window = {
		location: {
			pathname: '/onboarding/step-2',
			search: '?provider=square',
			hash: '',
		},
	} as Window & typeof globalThis
	try {
		expect(readRouterUrl(stubHandle(undefined))).toBe(
			'/onboarding/step-2?provider=square',
		)
		expect(readRouterPathname(stubHandle(undefined))).toBe('/onboarding/step-2')
		expect(readRouterSearch(stubHandle(undefined))).toBe('?provider=square')
	} finally {
		globalThis.window = previousWindow
	}
})
