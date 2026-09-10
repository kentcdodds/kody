import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	nextLightPlayerPlaying,
	YouTubeLightPlayer,
} from './youtube-light-player.tsx'
import { youtubeWatchSampleVideoId } from '#universal/youtube-watch.ts'

const videoId = youtubeWatchSampleVideoId
const otherVideoId = 'iGMkgjXc8Ho'

test('youtube light player paints a first-party poster without embedding', async () => {
	const html = await renderToString(
		jsx(YouTubeLightPlayer, {
			videoId,
			title: 'Watch the Kody demo',
			playTestId: 'landing-hero-video-play',
		}),
	)
	expect(html).toContain(`/youtube-thumb/${videoId}`)
	expect(html).toContain('data-testid="landing-hero-video-play"')
	expect(html).not.toContain('youtube-nocookie.com')
})

test('youtube light player embeds immediately when autoplay is set', async () => {
	const html = await renderToString(
		jsx(YouTubeLightPlayer, {
			videoId,
			playlistId: 'PLXa53KPj2nlE',
			title: 'Watch the Kody demo',
			autoplay: true,
		}),
	)
	expect(html).toContain(`youtube-nocookie.com/embed/${videoId}`)
	expect(html).toContain('list=PLXa53KPj2nlE')
	expect(html).not.toContain('data-testid="landing-hero-video-play"')
})

test('nextLightPlayerPlaying starts the same video when autoplay becomes true', () => {
	const poster = nextLightPlayerPlaying({
		playing: false,
		renderedVideoId: videoId,
		videoId,
		autoplay: false,
	})
	expect(poster).toEqual({ renderedVideoId: videoId, playing: false })

	const chooseCurrent = nextLightPlayerPlaying({
		playing: false,
		renderedVideoId: videoId,
		videoId,
		autoplay: true,
	})
	expect(chooseCurrent).toEqual({ renderedVideoId: videoId, playing: true })

	const stayPlaying = nextLightPlayerPlaying({
		playing: true,
		renderedVideoId: videoId,
		videoId,
		autoplay: false,
	})
	expect(stayPlaying).toEqual({ renderedVideoId: videoId, playing: true })

	const switchPoster = nextLightPlayerPlaying({
		playing: true,
		renderedVideoId: videoId,
		videoId: otherVideoId,
		autoplay: false,
	})
	expect(switchPoster).toEqual({
		renderedVideoId: otherVideoId,
		playing: false,
	})

	const switchAndPlay = nextLightPlayerPlaying({
		playing: false,
		renderedVideoId: videoId,
		videoId: otherVideoId,
		autoplay: true,
	})
	expect(switchAndPlay).toEqual({
		renderedVideoId: otherVideoId,
		playing: true,
	})
})
