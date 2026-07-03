import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	rateCommunityListing: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	rateCommunityListing: (...args: Array<unknown>) =>
		mockModule.rateCommunityListing(...args),
}))

const { communityRateCapability } = await import('./rate.ts')

function createCallerContext() {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'kody@example.com',
				displayName: 'Kody',
				username: 'kody',
			},
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

test('communityRateCapability rejects stars outside 1-5 bounds', async () => {
	await expect(
		communityRateCapability.handler(
			{
				listing_id: 'listing-1',
				stars: 0,
				adaptation_effort: 3,
			},
			createCallerContext(),
		),
	).rejects.toThrow()

	await expect(
		communityRateCapability.handler(
			{
				listing_id: 'listing-1',
				stars: 6,
				adaptation_effort: 3,
			},
			createCallerContext(),
		),
	).rejects.toThrow()
})

test('communityRateCapability calls service with validated input', async () => {
	mockModule.rateCommunityListing.mockReset()
	mockModule.rateCommunityListing.mockResolvedValue(undefined)

	const result = await communityRateCapability.handler(
		{
			listing_id: 'listing-1',
			stars: 4,
			adaptation_effort: 2,
			note: 'Easy to adapt',
		},
		createCallerContext(),
	)

	expect(result).toEqual({
		listing_id: 'listing-1',
		rated: true,
	})
	expect(mockModule.rateCommunityListing).toHaveBeenCalledWith({
		env: expect.objectContaining({ APP_DB: expect.anything() }),
		userId: 'user-1',
		listingId: 'listing-1',
		stars: 4,
		adaptationEffort: 2,
		note: 'Easy to adapt',
	})
})
