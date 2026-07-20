import { expect, test, vi } from 'vitest'
import {
	createCommunityStarApiPostHandler,
	createCommunityStargazersApiHandler,
} from './community-star.ts'
import { CommunityActionError } from '#worker/community/errors.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	starCommunityListing: vi.fn(),
	unstarCommunityListing: vi.fn(),
	listCommunityStargazersForListing: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/social-service.ts', () => ({
	starCommunityListing: (...args: Array<unknown>) =>
		mockModule.starCommunityListing(...args),
	unstarCommunityListing: (...args: Array<unknown>) =>
		mockModule.unstarCommunityListing(...args),
	listCommunityStargazersForListing: (...args: Array<unknown>) =>
		mockModule.listCommunityStargazersForListing(...args),
}))

const env = {} as Env

test('community star POST and stargazers API', async () => {
	const starHandler = createCommunityStarApiPostHandler(env)
	const stargazersHandler = createCommunityStargazersApiHandler(env)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await starHandler.handler({
		request: new Request('https://example.com/community/listing-1/star.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ starred: true }),
		}),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1/star.json'),
	} as never)
	expect(unauthorized.status).toBe(401)
	expect(mockModule.starCommunityListing).not.toHaveBeenCalled()

	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'stable-user' },
	})
	mockModule.starCommunityListing.mockResolvedValue(undefined)
	mockModule.listCommunityStargazersForListing.mockResolvedValue({
		totalStars: 1,
		stargazers: [
			{
				userId: 'stable-bob',
				username: 'bob',
				displayName: 'Bob',
				avatarKey: null,
				starredAt: '2026-07-01T00:00:00.000Z',
			},
		],
	})
	const starred = await starHandler.handler({
		request: new Request('https://example.com/community/listing-1/star.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ starred: true }),
		}),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1/star.json'),
	} as never)
	expect(starred.status).toBe(200)
	expect(await starred.json()).toEqual({
		ok: true,
		starred: true,
		starCount: 1,
	})
	expect(mockModule.starCommunityListing).toHaveBeenCalledWith({
		env,
		userId: 'stable-user',
		listingId: 'listing-1',
	})

	mockModule.unstarCommunityListing.mockResolvedValue(undefined)
	mockModule.listCommunityStargazersForListing.mockResolvedValue({
		totalStars: 0,
		stargazers: [],
	})
	const unstarred = await starHandler.handler({
		request: new Request('https://example.com/community/listing-1/star.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ starred: false }),
		}),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1/star.json'),
	} as never)
	expect(unstarred.status).toBe(200)
	expect(await unstarred.json()).toEqual({
		ok: true,
		starred: false,
		starCount: 0,
	})

	mockModule.starCommunityListing.mockRejectedValue(
		new CommunityActionError('Community listing "listing-1" was not found.'),
	)
	const missing = await starHandler.handler({
		request: new Request('https://example.com/community/listing-1/star.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ starred: true }),
		}),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1/star.json'),
	} as never)
	expect(missing.status).toBe(400)

	mockModule.listCommunityStargazersForListing.mockResolvedValue({
		totalStars: 2,
		stargazers: [
			{
				userId: 'stable-bob',
				username: 'bob',
				displayName: 'Bob',
				avatarKey: null,
				starredAt: '2026-07-01T00:00:00.000Z',
			},
		],
	})
	const stargazersResponse = await stargazersHandler.handler({
		request: new Request(
			'https://example.com/community/listing-1/stargazers.json',
		),
		params: { listingId: 'listing-1' },
		url: new URL('https://example.com/community/listing-1/stargazers.json'),
	} as never)
	const body = await stargazersResponse.json()
	expect(stargazersResponse.status).toBe(200)
	expect(body).toEqual({
		ok: true,
		totalStars: 2,
		stargazers: [
			{
				username: 'bob',
				displayName: 'Bob',
				avatarUrl: null,
				starredAt: '2026-07-01T00:00:00.000Z',
			},
		],
	})
	expect(body.stargazers[0]).not.toHaveProperty('userId')
	expect(mockModule.listCommunityStargazersForListing).toHaveBeenCalledWith({
		env,
		listingId: 'listing-1',
		limit: 20,
	})
})
