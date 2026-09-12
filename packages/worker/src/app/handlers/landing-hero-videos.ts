import { type Action } from 'remix/router'
import { jsonResponse } from '#worker/json-response.ts'
import { publicSharedJsonCacheHeaders } from '#app/anonymous-html-cache.ts'
import { loadLandingHeroVideos } from '#app/landing-hero-videos.ts'
import { type routes } from '#universal/routes.ts'

export function createLandingHeroVideosApiHandler(env: Env) {
	return {
		middleware: [],
		async handler() {
			const videos = await loadLandingHeroVideos({ env })
			return jsonResponse(
				{ ok: true, videos },
				{ headers: publicSharedJsonCacheHeaders() },
			)
		},
	} satisfies Action<typeof routes.landingHeroVideosApi>
}
