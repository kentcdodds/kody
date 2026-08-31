import { expect, test } from 'vitest'
import { decideCommunityInstallClick } from './community-detail-install.ts'

test('decideCommunityInstallClick covers idle confirm, ignore gates, and error retry', () => {
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: false,
		}),
	).toBe('confirm')

	expect(
		decideCommunityInstallClick({
			installState: 'submitting',
			alreadyInstalled: false,
		}),
	).toBe('ignore')
	expect(
		decideCommunityInstallClick({
			installState: 'confirming',
			alreadyInstalled: false,
		}),
	).toBe('ignore')
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: true,
		}),
	).toBe('ignore')

	expect(
		decideCommunityInstallClick({
			installState: 'error',
			alreadyInstalled: false,
		}),
	).toBe('confirm')
})
