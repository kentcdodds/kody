import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { YouTubeWatchOverlay } from './youtube-watch-overlay.tsx'

const videoId = 'QA0xYMAMjEg'

test('youtube watch overlay stays closed without an allowlisted video', async () => {
	const html = await renderToString(jsx(YouTubeWatchOverlay, {}))
	expect(html).not.toContain('data-testid="youtube-watch-overlay"')
})

test('youtube watch overlay ignores requested ids that are not allowlisted', async () => {
	const html = await renderToString(
		jsx(YouTubeWatchOverlay, {
			snapshot: {
				allowedVideoIds: ['dQw4w9wgvcQ'],
				requestedVideoId: videoId,
			},
		}),
	)
	expect(html).not.toContain('data-testid="youtube-watch-overlay"')
})

test('youtube watch overlay paints a poster for an allowlisted requested id', async () => {
	const html = await renderToString(
		jsx(YouTubeWatchOverlay, {
			snapshot: {
				allowedVideoIds: [videoId],
				requestedVideoId: videoId,
			},
		}),
	)
	expect(html).toContain('data-testid="youtube-watch-overlay"')
	expect(html).toContain(`data-video-id="${videoId}"`)
	expect(html).toContain(`/youtube-thumb/${videoId}`)
	expect(html).toContain('data-testid="youtube-watch-play"')
	expect(html).not.toContain('youtube-nocookie.com')
})
