import { expect, test } from 'vitest'
import { decideCommunityInstallClick } from './community-detail-install.ts'

test('trusted idle install submits immediately', () => {
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: false,
			listingTrusted: true,
		}),
	).toBe('submit')
})

test('untrusted idle install asks for confirmation even if the frame still says trusted', () => {
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: false,
			listingTrusted: false,
		}),
	).toBe('confirm')
})

test('install clicks are ignored while submitting, confirming, or already installed', () => {
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
})

test('a failed install can be retried', () => {
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
