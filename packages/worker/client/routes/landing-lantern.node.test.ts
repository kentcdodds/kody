import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { renderLanternGlyph } from './landing-lantern.tsx'
import { iconicGlyphViewBox } from '#universal/icon.tsx'
import { landingLanternOrbs } from '#universal/landing-lantern.ts'

test('every lantern orb glyph is a decorative currentColor stroke in the Iconic box', async () => {
	for (const orb of landingLanternOrbs) {
		const html = await renderToString(renderLanternGlyph(orb.glyph))
		expect(html).toContain(`viewBox="${iconicGlyphViewBox}"`)
		expect(html).toContain('aria-hidden="true"')
		expect(html).toContain('stroke="currentColor"')
		expect(html).not.toMatch(/<svg[^>]*\bstroke=/)
		// Every cubic segment has its full six numbers.
		for (const d of html.matchAll(/\sd="([^"]+)"/g)) {
			const cubic = d[1]!.match(/C([^A-Za-z]+)/)
			if (!cubic) continue
			const count = cubic[1]!.trim().split(/[\s,]+/).length
			expect(count % 6).toBe(0)
		}
	}
})
