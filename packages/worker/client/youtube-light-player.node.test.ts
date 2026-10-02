import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { css } from 'remix/component'
import { expect, test } from 'vitest'
import { DocYoutubeEmbed } from './doc-youtube-embed.tsx'
import {
	nextLightPlayerPlaying,
	YouTubeLightPlayer,
} from './youtube-light-player.tsx'
import { proseCss } from '#universal/styles/style-primitives.ts'
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
	expect(html).toContain('▶')
	expect(html).not.toContain('youtube-nocookie.com')
})

test('docs prose image margin does not inset the youtube poster', async () => {
	const html = await renderToString(
		jsx('div', {
			mix: css(proseCss),
			children: jsx(DocYoutubeEmbed, {
				videoId,
				title: 'How Kody Gives Your Agent a Computer',
				label: 'Watch: How Kody Gives Your Agent a Computer',
			}),
		}),
	)
	expect(html).toContain('data-doc-youtube')
	const proseClass = html.match(/<div[^>]*class="([^"]+)"/)?.[1]
	expect(proseClass).toBeTruthy()
	const proseStyleStart = html.indexOf(`data-rmx-style="${proseClass}"`)
	const proseStyle = html.slice(
		proseStyleStart,
		html.indexOf('</style>', proseStyleStart),
	)
	expect(proseStyle).toContain('height: auto')
	expect(proseStyle).toContain('margin: 1.15rem 0 0')
	const posterReset = proseStyle.match(
		/\[data-doc-youtube\] img \{\n([^}]+)\}/,
	)?.[1]
	expect(posterReset).toContain('margin: 0')
	expect(posterReset).toContain('height: 100%')
	expect(posterReset).toContain('border: none')
	expect(posterReset).toContain('object-fit: cover')
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
