import { acquisitionPageMeta } from '#universal/acquisition/metadata.ts'
import { trackFathomEvent } from './fathom-events.ts'

export function trackAcquisitionOnboardingClick(pageKey: string): boolean {
	try {
		if (
			!Object.hasOwn(acquisitionPageMeta, pageKey) ||
			window.location.origin !== 'https://kody.codes'
		)
			return false
		if (
			navigator.doNotTrack === '1' ||
			(navigator as Navigator & { globalPrivacyControl?: boolean })
				.globalPrivacyControl
		)
			return false
		return trackFathomEvent(`acquisition_${pageKey}_onboarding_clicked`)
	} catch {
		return false
	}
}
