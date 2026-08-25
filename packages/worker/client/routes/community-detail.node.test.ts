import { expect, test } from 'vitest'
import { decideCommunityInstallClick } from './community-detail-install.ts'

test('decideCommunityInstallClick covers idle submit/confirm, ignore gates, and error retry', () => {
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: false,
			listingTrusted: true,
		}),
	).toBe('submit')
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: false,
			listingTrusted: false,
		}),
	).toBe('confirm')

	expect(
		decideCommunityInstallClick({
			installState: 'submitting',
			alreadyInstalled: false,
			listingTrusted: true,
		}),
	).toBe('ignore')
	expect(
		decideCommunityInstallClick({
			installState: 'confirming',
			alreadyInstalled: false,
			listingTrusted: false,
		}),
	).toBe('ignore')
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: true,
			listingTrusted: true,
		}),
	).toBe('ignore')

	expect(
		decideCommunityInstallClick({
			installState: 'error',
			alreadyInstalled: false,
			listingTrusted: true,
		}),
	).toBe('submit')
	expect(
		decideCommunityInstallClick({
			installState: 'error',
			alreadyInstalled: false,
			listingTrusted: false,
		}),
	).toBe('confirm')
})
