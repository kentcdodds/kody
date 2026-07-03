import { type Action } from 'remix/router'
import { Layout } from '#app/layout.ts'
import {
	buildCommunityIndexOgHead,
	toPublicCommunityListing,
} from '#app/community-public.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'
import {
	listCommunityListingsWithAggregates,
	searchCommunityListings,
} from '#worker/community/service.ts'

const defaultCommunityListLimit = 50

export function createCommunityHandler(_env: Env) {
	return {
		middleware: [],
		async handler() {
			return render(
				Layout({
					title: 'Community packages',
					head: buildCommunityIndexOgHead(),
				}),
			)
		},
	} satisfies Action<typeof routes.community>
}

export function createCommunityApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const url = new URL(request.url)
			const query = url.searchParams.get('q')?.trim() ?? ''
			const limit = readPositiveInt(url.searchParams.get('limit'), {
				defaultValue: defaultCommunityListLimit,
				max: 100,
			})

			const listings = query
				? await searchCommunityListings({
						env,
						query,
						limit,
					})
				: await listCommunityListingsWithAggregates({
						env,
						includeDelisted: false,
						limit,
						offset: 0,
					})

			return jsonResponse({
				ok: true,
				listings: listings.map(toPublicCommunityListing),
				query: query || null,
			})
		},
	} satisfies Action<typeof routes.communityApi>
}

function readPositiveInt(
	value: string | null,
	input: { defaultValue: number; max: number },
) {
	if (!value) return input.defaultValue
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) return input.defaultValue
	return Math.min(parsed, input.max)
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
		},
	})
}
