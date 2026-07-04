import { type PublicCommunityListing } from '#app/community-public.ts'

export type CommunityIndexLoaderData = {
	ok: true
	listings: Array<PublicCommunityListing>
	query: string | null
}

export type CommunityDetailLoaderData = {
	ok: true
	listing: PublicCommunityListing
	loggedIn: boolean
	forkPrompt: string
}

/**
 * Route-keyed loader payloads embedded in AppRoot props during SSR.
 * Add a key here when converting a route; handlers and route components
 * share these types with the JSON API response shapes.
 */
export type AppLoaderData = {
	community?: CommunityIndexLoaderData
	communityDetail?: CommunityDetailLoaderData
}

export function getRequestUrl(request: Request) {
	const url = new URL(request.url)
	return `${url.pathname}${url.search}${url.hash}`
}
