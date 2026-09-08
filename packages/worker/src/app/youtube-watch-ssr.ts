import { parseYoutubeWatchSearch } from '#universal/youtube-watch.ts'
import { type YoutubeWatchLoaderData } from '#universal/loader-data.ts'
import { resolveYoutubeWatchAllowedVideoIds } from '#app/youtube-watch-allowlist.ts'

export function emptyYoutubeWatchLoaderData(): YoutubeWatchLoaderData {
	return {
		allowedVideoIds: [],
		requestedVideoId: null,
	}
}

export async function loadYoutubeWatchLoaderData(input: {
	request: Request
	env: Env
}): Promise<YoutubeWatchLoaderData> {
	const requestedVideoId = parseYoutubeWatchSearch(
		new URL(input.request.url).search,
	)
	try {
		const allowedVideoIds = await resolveYoutubeWatchAllowedVideoIds({
			env: input.env,
		})
		return { allowedVideoIds, requestedVideoId }
	} catch (error) {
		console.error('youtube watch allowlist load failed', error)
		return { allowedVideoIds: [], requestedVideoId }
	}
}
