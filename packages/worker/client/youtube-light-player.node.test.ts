import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { YouTubeLightPlayer } from './youtube-light-player.tsx'
import { youtubeWatchSampleVideoId } from '#universal/youtube-watch.ts'

const videoId = youtubeWatchSampleVideoId

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
	expect(html).toContain('Play video')
	expect(html).not.toContain('youtube-nocookie.com')
})
