import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	getCommunityListingByOwnerAndPackage: vi.fn(),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingByOwnerAndPackage: (...args: Array<unknown>) =>
		mockModule.getCommunityListingByOwnerAndPackage(...args),
}))

const { readPromotedVersionFromManifest, resolveListingBehindPublishHint } =
	await import('./resolve-listing-behind-publish-hint.ts')

test('resolveListingBehindPublishHint returns null without an active behind listing', async () => {
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(null)
	expect(
		await resolveListingBehindPublishHint({
			db: {} as D1Database,
			ownerUserId: 'user-1',
			packageId: 'pkg-1',
			ownerUsername: 'danj',
			kodyId: 'hey-email',
			promotedCommit: 'commit-new',
			promotedVersion: '1.5.0',
		}),
	).toBeNull()

	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue({
		id: 'listing-1',
		status: 'active',
		pinnedCommit: 'commit-new',
		version: '1.5.0',
	})
	expect(
		await resolveListingBehindPublishHint({
			db: {} as D1Database,
			ownerUserId: 'user-1',
			packageId: 'pkg-1',
			ownerUsername: 'danj',
			kodyId: 'hey-email',
			promotedCommit: 'commit-new',
			promotedVersion: '1.5.0',
		}),
	).toBeNull()
})

test('resolveListingBehindPublishHint builds the update hint for a lagging listing', async () => {
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue({
		id: 'listing-1',
		status: 'active',
		pinnedCommit: 'commit-old',
		version: '1.4.0',
	})
	await expect(
		resolveListingBehindPublishHint({
			db: {} as D1Database,
			ownerUserId: 'user-1',
			packageId: 'pkg-1',
			ownerUsername: 'danj',
			kodyId: 'hey-email',
			promotedCommit: 'commit-new',
			promotedVersion: '1.5.0',
		}),
	).resolves.toEqual({
		pinnedVersion: '1.4.0',
		promotedVersion: '1.5.0',
		behind: true,
		updateHint: expect.stringContaining('automatically'),
		updateUrl: '/@danj/hey-email/settings#update-public-listing',
	})
})

test('resolveListingBehindPublishHint returns null when the catalog lookup rejects', async () => {
	consoleWarn.mockImplementation(() => {})
	mockModule.getCommunityListingByOwnerAndPackage.mockRejectedValue(
		new Error('D1 unavailable'),
	)
	expect(
		await resolveListingBehindPublishHint({
			db: {} as D1Database,
			ownerUserId: 'user-1',
			packageId: 'pkg-1',
			ownerUsername: 'danj',
			kodyId: 'hey-email',
			promotedCommit: 'commit-new',
			promotedVersion: '1.5.0',
		}),
	).toBeNull()
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('listing-behind-hint'),
		'D1 unavailable',
	)
})

test('readPromotedVersionFromManifest reads package.json version strings', () => {
	expect(readPromotedVersionFromManifest({ version: '1.5.0' })).toBe('1.5.0')
	expect(readPromotedVersionFromManifest({ version: 2 })).toBeNull()
	expect(readPromotedVersionFromManifest(null)).toBeNull()
})
