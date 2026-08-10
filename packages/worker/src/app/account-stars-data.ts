import { toPublicCommunityListing } from '#app/community-public.ts'
import { type AccountStarsLoaderData } from '#universal/loader-data.ts'
import { listStarredCommunityListings } from '#worker/community/social-service.ts'

const defaultStarsLimit = 100

export async function loadAccountStarsData(input: {
	env: Env
	userId: string
}): Promise<AccountStarsLoaderData> {
	const listings = await listStarredCommunityListings({
		env: input.env,
		userId: input.userId,
		limit: defaultStarsLimit,
	})
	return {
		ok: true,
		listings: listings.map(toPublicCommunityListing),
	}
}
