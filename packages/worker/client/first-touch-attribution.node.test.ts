import { expect, test } from 'vitest'
import {
	captureFirstTouchAttributionFromLocation,
	clearStoredFirstTouchAttribution,
} from './first-touch-attribution.ts'

const originalSessionStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	'sessionStorage',
)

function restoreSessionStorage() {
	if (originalSessionStorage) {
		Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage)
	} else {
		Reflect.deleteProperty(globalThis, 'sessionStorage')
	}
}

function installSessionStorage() {
	const store = new Map<string, string>()
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		value: {
			getItem(key: string) {
				return store.get(key) ?? null
			},
			setItem(key: string, value: string) {
				store.set(key, value)
			},
			removeItem(key: string) {
				store.delete(key)
			},
		},
	})
	clearStoredFirstTouchAttribution()
}

test('first-touch UTMs stay write-once and ignore later share links', () => {
	try {
		installSessionStorage()
		const homepage = captureFirstTouchAttributionFromLocation(
			'https://kody.codes/',
			null,
		)
		expect(homepage).toEqual({
			utmSource: null,
			utmMedium: null,
			utmCampaign: null,
			utmContent: null,
			utmTerm: null,
			landingPath: '/',
			referrer: null,
		})

		expect(
			captureFirstTouchAttributionFromLocation(
				'https://kody.codes/signup?ref=Ada',
				null,
			),
		).toEqual(homepage)
		expect(
			captureFirstTouchAttributionFromLocation(
				'https://kody.codes/signup?utm_source=youtube',
				null,
			),
		).toEqual(homepage)
	} finally {
		restoreSessionStorage()
	}
})
