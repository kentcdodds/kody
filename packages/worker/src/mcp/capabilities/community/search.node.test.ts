import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	searchCommunityListings: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	searchCommunityListings: (...args: Array<unknown>) =>
		mockModule.searchCommunityListings(...args),
}))

const { communitySearchCapability } = await import('./search.ts')

function createContext() {
	return {
		env: {} as Env,
		callerContext: {
			baseUrl: 'https://kody.test',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				username: 'user',
				displayName: 'User',
			},
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

test('community search labels unrelated queries and exposes relevance for matches', async () => {
	mockModule.searchCommunityListings.mockResolvedValueOnce([])

	const noMatchResult = await communitySearchCapability.handler(
		{ query: 'text to speech audio narration', limit: 10 },
		createContext(),
	)

	expect(noMatchResult).toEqual({
		outcome: 'no_matches',
		guidance: expect.stringContaining(
			'No community packages met the relevance floor',
		),
		matches: [],
	})

	mockModule.searchCommunityListings.mockResolvedValueOnce([
		{
			id: 'listing-github',
			kodyId: 'github-triage',
			name: '@kody/github-triage',
			description: 'Triage GitHub issues automatically',
			tags: ['github', 'triage'],
			trusted: true,
			relevance: 0.64,
			averageStars: 4.5,
			ratingCount: 8,
			averageAdaptationEffort: 2,
			forkCount: 3,
			starCount: 4,
		},
	])

	const matchResult = await communitySearchCapability.handler(
		{ query: 'github issue triage', limit: 10 },
		createContext(),
	)

	expect(matchResult).toEqual({
		outcome: 'matches',
		guidance: expect.any(String),
		matches: [
			expect.objectContaining({
				listing_id: 'listing-github',
				kody_id: 'github-triage',
				relevance: 0.64,
			}),
		],
	})
})
