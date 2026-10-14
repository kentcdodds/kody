import { expect, test } from 'vitest'
import { buildCommunityListingBehindHint } from './update-public-listing.ts'

test('buildCommunityListingBehindHint returns null when pins match or are missing', () => {
	expect(
		buildCommunityListingBehindHint({
			listingPinnedCommit: 'abc1234',
			promotedCommit: 'abc1234',
			updateUrl: '/@danj/hey-email/settings#update-public-listing',
		}),
	).toBeNull()
	expect(
		buildCommunityListingBehindHint({
			listingPinnedCommit: '',
			promotedCommit: 'def5678',
			updateUrl: '/@danj/hey-email/settings#update-public-listing',
		}),
	).toBeNull()
})

test('buildCommunityListingBehindHint describes versions and that sync catches up', () => {
	const hint = buildCommunityListingBehindHint({
		listingPinnedCommit: '7f9dc2fd04074fecd9b3bbdbb8e4a6c75c04b9e8',
		promotedCommit: '4665dddb7b7347291bd99049ba0f67ca101ee082',
		pinnedVersion: '1.4.0',
		promotedVersion: '1.5.0',
		updateUrl: '/@danj/hey-email/settings#update-public-listing',
	})
	expect(hint).toEqual({
		pinnedVersion: '1.4.0',
		promotedVersion: '1.5.0',
		behind: true,
		updateHint: expect.stringContaining('automatically'),
		updateUrl: '/@danj/hey-email/settings#update-public-listing',
	})
	expect(hint?.updateHint).toContain('1.4.0')
	expect(hint?.updateHint).toContain('1.5.0')
	expect(hint?.updateHint).toContain('No manual republish')
})

test('buildCommunityListingBehindHint falls back to short commits when versions are absent', () => {
	const hint = buildCommunityListingBehindHint({
		listingPinnedCommit: '7f9dc2fd04074fecd9b3bbdbb8e4a6c75c04b9e8',
		promotedCommit: '4665dddb7b7347291bd99049ba0f67ca101ee082',
		updateUrl: '/@danj/hey-email/settings#update-public-listing',
	})
	expect(hint?.pinnedVersion).toBeNull()
	expect(hint?.promotedVersion).toBeNull()
	expect(hint?.updateHint).toContain('7f9dc2f')
	expect(hint?.updateHint).toContain('4665ddd')
})
