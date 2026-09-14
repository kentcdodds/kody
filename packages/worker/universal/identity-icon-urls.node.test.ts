import { expect, test } from 'vitest'
import {
	buildCommunityIconUrl,
	buildPackageIdentityIconUrl,
	buildRepoIdentityIconUrl,
	resolvePackageListIconUrl,
} from './identity-icon-urls.ts'

test('identity icon URLs embed the indexed commit', () => {
	expect(
		buildCommunityIconUrl({
			listingId: 'listing-1',
			iconCommit: 'abc123',
		}),
	).toBe('/community/listing-1/icon/abc123')
	expect(
		buildPackageIdentityIconUrl({
			username: 'kentcdodds',
			kodyId: 'github',
			iconCommit: 'def456',
		}),
	).toBe('/@kentcdodds/github/icon/def456')
	expect(
		buildRepoIdentityIconUrl({
			repoId: 'repo-1',
			iconCommit: 'fff111',
		}),
	).toBe('/account/repos/repo-1/icon/fff111')
})

test('package list icons prefer the community listing URL then the published package URL', () => {
	expect(
		resolvePackageListIconUrl({
			username: 'kentcdodds',
			kodyId: 'github',
			listingId: 'listing-1',
			listingIconCommit: 'pin-1',
			publishedCommit: 'pub-2',
		}),
	).toBe('/community/listing-1/icon/pin-1')
	expect(
		resolvePackageListIconUrl({
			username: 'kentcdodds',
			kodyId: 'github',
			listingId: null,
			listingIconCommit: null,
			publishedCommit: 'pub-2',
		}),
	).toBe('/@kentcdodds/github/icon/pub-2')
	expect(
		resolvePackageListIconUrl({
			username: 'kentcdodds',
			kodyId: 'github',
			listingId: null,
			listingIconCommit: null,
			publishedCommit: null,
		}),
	).toBeNull()
})
