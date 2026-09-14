import { expect, test } from 'vitest'
import { type ProfileListLoaderData } from '#universal/loader-data.ts'
import { profileListForUsername } from './profile-list-for-username.ts'

const janeList = {
	profile: {
		username: 'jane',
		displayName: 'Jane',
		bio: null,
		avatarUrl: null,
		visibility: 'public',
		joinedAt: '2026-01-01T00:00:00.000Z',
		publicPackageCount: 0,
		listingCount: 0,
	},
	packages: [
		{
			name: '@jane/secret-vault',
			kodyId: 'secret-vault',
			description: 'Private vault',
			tags: [],
			updatedAt: '2026-09-14T00:00:00.000Z',
			communityListingId: null,
			communityListingKodyId: null,
			communityPublishedAt: null,
			needsRepublish: false,
			hasApp: false,
			webhookCount: 0,
			jobCount: 0,
			iconUrl: null,
			isPrivate: true,
			hidden: false,
		},
	],
	activity: [],
} satisfies ProfileListLoaderData

test('profile list stays on the username it was loaded for', () => {
	expect(profileListForUsername(janeList, 'jane', 'jane')).toBe(janeList)
	expect(profileListForUsername(janeList, 'jane', 'kody')).toBeNull()
	expect(profileListForUsername(janeList, null, 'jane')).toBeNull()
	expect(profileListForUsername(null, 'jane', 'jane')).toBeNull()
	expect(
		profileListForUsername(
			{
				...janeList,
				profile: { ...janeList.profile, username: 'kody' },
			},
			'jane',
			'jane',
		),
	).toBeNull()
})
