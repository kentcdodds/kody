import { afterEach, expect, test, vi } from 'vitest'
import { trackAcquisitionOnboardingClick } from './acquisition-analytics.ts'

afterEach(() => vi.unstubAllGlobals())
function setup(origin = 'https://kody.codes', privacy = {}) {
	const trackEvent = vi.fn()
	vi.stubGlobal('window', { location: { origin }, fathom: { trackEvent } })
	vi.stubGlobal('navigator', privacy)
	return trackEvent
}
test('uses a fixed page key for onboarding intent without sending visitor data', () => {
	const event = setup()
	expect(trackAcquisitionOnboardingClick('gmail')).toBe(true)
	expect(event).toHaveBeenCalledExactlyOnceWith(
		'acquisition_gmail_onboarding_clicked',
	)
	expect(trackAcquisitionOnboardingClick('unknown?email=private')).toBe(false)
	expect(trackAcquisitionOnboardingClick('constructor')).toBe(false)
	expect(event).toHaveBeenCalledTimes(1)
})
test('does not send local or preview events', () => {
	for (const origin of [
		'http://127.0.0.1:3752',
		'https://preview.kody.codes',
	]) {
		const event = setup(origin)
		expect(trackAcquisitionOnboardingClick('gmail')).toBe(false)
		expect(event).not.toHaveBeenCalled()
	}
})
test('respects browser privacy signals', () => {
	for (const privacy of [{ doNotTrack: '1' }, { globalPrivacyControl: true }]) {
		const event = setup('https://kody.codes', privacy)
		expect(trackAcquisitionOnboardingClick('gmail')).toBe(false)
		expect(event).not.toHaveBeenCalled()
	}
})
test('missing analytics never interrupts a CTA', () => {
	setup()
	vi.stubGlobal('window', { location: { origin: 'https://kody.codes' } })
	expect(trackAcquisitionOnboardingClick('gmail')).toBe(false)
})
