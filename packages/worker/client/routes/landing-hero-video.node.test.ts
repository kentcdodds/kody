import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	chooserOverflow,
	LandingHeroVideo,
	nextChooserIndex,
} from './landing-hero-video.tsx'
import { landingHeroDemoVideos } from '#universal/landing-hero-copy.ts'

test('nextChooserIndex moves along the strip, wraps at the ends, ignores other keys', () => {
	expect(nextChooserIndex(0, 'ArrowRight', 3)).toBe(1)
	expect(nextChooserIndex(0, 'ArrowDown', 3)).toBe(1)
	expect(nextChooserIndex(2, 'ArrowRight', 3)).toBe(0)
	expect(nextChooserIndex(1, 'ArrowLeft', 3)).toBe(0)
	expect(nextChooserIndex(1, 'ArrowUp', 3)).toBe(0)
	expect(nextChooserIndex(0, 'ArrowLeft', 3)).toBe(2)
	expect(nextChooserIndex(1, 'Home', 3)).toBe(0)
	expect(nextChooserIndex(1, 'End', 3)).toBe(2)
	expect(nextChooserIndex(1, 'Enter', 3)).toBeNull()
	expect(nextChooserIndex(1, 'a', 3)).toBeNull()
	expect(nextChooserIndex(0, 'ArrowRight', 0)).toBeNull()
})

test('chooserOverflow only reports an edge when there is content past it', () => {
	const fits = { scrollLeft: 0, clientWidth: 400, scrollWidth: 400 }
	expect(chooserOverflow(fits)).toEqual({ start: false, end: false })
	const atStart = { scrollLeft: 0, clientWidth: 400, scrollWidth: 900 }
	expect(chooserOverflow(atStart)).toEqual({ start: false, end: true })
	const middle = { scrollLeft: 200, clientWidth: 400, scrollWidth: 900 }
	expect(chooserOverflow(middle)).toEqual({ start: true, end: true })
	const atEnd = { scrollLeft: 500, clientWidth: 400, scrollWidth: 900 }
	expect(chooserOverflow(atEnd)).toEqual({ start: true, end: false })
	// Sub-pixel scroll positions do not flicker the fades.
	const nearlyEnd = { scrollLeft: 499.5, clientWidth: 400, scrollWidth: 900 }
	expect(chooserOverflow(nearlyEnd)).toEqual({ start: true, end: false })
})

test('hero video renders the first video in the player and every video as a listbox option', async () => {
	const html = await renderToString(jsx(LandingHeroVideo, {}))
	const [first, ...rest] = landingHeroDemoVideos
	if (!first) throw new Error('expected at least one hero video')

	// Poster, not an embed, until the visitor clicks.
	expect(html).not.toContain('youtube-nocookie.com')
	expect(html).toContain('data-testid="landing-hero-video-play"')

	expect(html).toContain('role="listbox"')
	expect(html).toContain('tabindex="0"')
	expect(html.match(/role="option"/g)).toHaveLength(
		landingHeroDemoVideos.length,
	)
	expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
	expect(html).toContain(`/youtube-thumb/${first.videoId}`)
	for (const video of rest) {
		expect(html).toContain(`/youtube-thumb/${video.videoId}`)
		expect(html).toContain(video.title)
	}
})
