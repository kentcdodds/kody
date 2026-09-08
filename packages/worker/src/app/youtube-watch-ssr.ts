import { type YoutubeWatchLoaderData } from '#universal/loader-data.ts'
import {
	resolveYoutubeWatchAllowedVideoIds,
	type YoutubeWatchBannerHrefs,
} from '#app/youtube-watch-allowlist.ts'

export async function loadYoutubeWatchLoaderData(input: {
	env: Env
	listedBanners?:
		| Promise<ReadonlyArray<YoutubeWatchBannerHrefs>>
		| ReadonlyArray<YoutubeWatchBannerHrefs>
	loadPlaylists?: boolean
}): Promise<YoutubeWatchLoaderData> {
	try {
		const allowedVideoIds = await resolveYoutubeWatchAllowedVideoIds({
			env: input.env,
			listedBanners: input.listedBanners,
			loadPlaylists: input.loadPlaylists,
		})
		return { allowedVideoIds }
	} catch (error) {
		console.error('youtube watch allowlist load failed', error)
		return { allowedVideoIds: [] }
	}
}
