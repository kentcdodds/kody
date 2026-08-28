import { expect, test, vi } from 'vitest'
import {
	consumeAccountCreatedFathomSignal,
	fathomEventNames,
	scheduleConsumeAccountCreatedFathomSignal,
	trackFathomEvent,
} from './fathom-events.ts'

test('Fathom track and account-created consume strip the query once Fathom is ready', () => {
	const trackEvent = vi.fn()
	vi.stubGlobal('window', {
		fathom: { trackEvent },
	})
	expect(trackFathomEvent(fathomEventNames.signupStarted)).toBe(true)
	expect(trackEvent).toHaveBeenCalledWith('signup_started')

	vi.stubGlobal('window', {})
	expect(trackFathomEvent('account_created')).toBe(false)

	const replaceStateUnavailable = vi.fn()
	vi.stubGlobal('window', {
		location: {
			href: 'https://kody.codes/onboarding?accountCreated=1',
		},
		history: { state: null, replaceState: replaceStateUnavailable },
	})
	expect(consumeAccountCreatedFathomSignal()).toBe(false)
	expect(replaceStateUnavailable).not.toHaveBeenCalled()

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
	expect(trackEvent).toHaveBeenCalledTimes(2)

	vi.unstubAllGlobals()
})

test('scheduleConsumeAccountCreatedFathomSignal retries until Fathom loads and no-ops without the query', () => {
	vi.useFakeTimers()
	const trackEvent = vi.fn()
	const replaceState = vi.fn()
	let href = 'https://kody.codes/onboarding?accountCreated=1'
	const win: {
		location: { href: string }
		history: {
			state: null
			replaceState: (_state: unknown, _title: string, next: string) => void
		}
		fathom?: { trackEvent: typeof trackEvent }
		setInterval: typeof setInterval
		clearInterval: typeof clearInterval
	} = {
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
		setInterval,
		clearInterval,
	}
	vi.stubGlobal('window', win)

	const cancel = scheduleConsumeAccountCreatedFathomSignal({
		intervalMs: 100,
		maxAttempts: 5,
	})
	expect(trackEvent).not.toHaveBeenCalled()

	win.fathom = { trackEvent }
	vi.advanceTimersByTime(100)
	expect(trackEvent).toHaveBeenCalledWith('account_created')
	expect(replaceState).toHaveBeenCalledWith(null, '', '/onboarding')
	cancel()
	vi.useRealTimers()

	const setIntervalSpy = vi.fn()
	vi.stubGlobal('window', {
		location: { href: 'https://kody.codes/account' },
		setInterval: setIntervalSpy,
		clearInterval: vi.fn(),
	})
	const noopCancel = scheduleConsumeAccountCreatedFathomSignal()
	expect(setIntervalSpy).not.toHaveBeenCalled()
	noopCancel()
	vi.unstubAllGlobals()
})
