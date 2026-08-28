import { afterEach, expect, test, vi } from 'vitest'
import {
	consumeAccountCreatedFathomSignal,
	fathomEventNames,
	trackFathomEvent,
} from './fathom-events.ts'

afterEach(() => {
	vi.unstubAllGlobals()
})

test('trackFathomEvent calls window.fathom.trackEvent when present', () => {
	const trackEvent = vi.fn()
	vi.stubGlobal('window', {
		fathom: { trackEvent },
	})
	trackFathomEvent(fathomEventNames.signupStarted)
	expect(trackEvent).toHaveBeenCalledWith('signup_started')
})

test('trackFathomEvent no-ops without fathom and never throws', () => {
	vi.stubGlobal('window', {})
	expect(() => trackFathomEvent('account_created')).not.toThrow()
})

test('consumeAccountCreatedFathomSignal fires once and strips the query', () => {
	const trackEvent = vi.fn()
	const replaceState = vi.fn()
	let href = 'https://kody.codes/onboarding?accountCreated=1'
	vi.stubGlobal('window', {
		get location() {
			return { href }
		},
		history: {
			state: null,
			replaceState(_state: unknown, _title: string, next: string) {
				replaceState(_state, _title, next)
				href = `https://kody.codes${next}`
			},
		},
		fathom: { trackEvent },
	})
	expect(consumeAccountCreatedFathomSignal()).toBe(true)
	expect(trackEvent).toHaveBeenCalledWith('account_created')
	expect(replaceState).toHaveBeenCalledWith(null, '', '/onboarding')
	expect(consumeAccountCreatedFathomSignal()).toBe(false)
	expect(trackEvent).toHaveBeenCalledTimes(1)
})
