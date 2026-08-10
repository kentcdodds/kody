import { type Action } from 'remix/router'
import { loadCommunityIndexData } from '#app/community-data.ts'
import { getRequestDataCacheLookup } from '#app/request-cache.ts'
import { type routes } from '#universal/routes.ts'

export function createCommunityApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const community = await loadCommunityIndexData(env, request)
			const headers: Record<string, string> = {
				'Cache-Control': 'no-store',
				'Content-Type': 'application/json; charset=utf-8',
			}
			const cacheLookup = getRequestDataCacheLookup(request)
			if (cacheLookup) {
				headers['X-Kody-Cache'] = cacheLookup
			}

			return new Response(JSON.stringify(community), {
				status: 200,
				headers,
			})
		},
	} satisfies Action<typeof routes.communityApi>
}
