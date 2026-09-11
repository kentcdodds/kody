import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { Icon, iconicGlyphViewBox, renderIcon } from './icon.tsx'

test('Iconic icons crop padded viewBoxes and stay decorative unless titled', async () => {
	const decorative = await renderToString(
		jsx(Icon, { name: 'home', size: '16' }),
	)
	expect(decorative).toContain(`viewBox="${iconicGlyphViewBox}"`)
	expect(decorative).toContain('data-icon="home"')
	expect(decorative).toContain('aria-hidden="true"')
	expect(decorative).not.toContain('aria-label')
	expect(decorative).toContain('stroke="currentColor"')
	expect(decorative).toContain('width="16"')
	expect(iconicGlyphViewBox).toBe('3.75 3.75 16.5 16.5')

	const labelled = await renderToString(
		jsx(Icon, { name: 'search', title: 'Search files' }),
	)
	expect(labelled).toContain('aria-label="Search files"')
	expect(labelled).toContain('role="img"')
	expect(labelled).not.toContain('aria-hidden')

	const helper = await renderToString(renderIcon('mail'))
	expect(helper).toContain('data-icon="mail"')
	expect(helper).toContain('aria-hidden="true"')
})

test('every Iconic glyph name has a cropped currentColor stroke', async () => {
	const { iconNames } = await import('./icon-glyphs.tsx')
	for (const name of iconNames) {
		const html = await renderToString(renderIcon(name))
		expect(html).toContain(`data-icon="${name}"`)
		expect(html).toContain(`viewBox="${iconicGlyphViewBox}"`)
		expect(html).toContain('aria-hidden="true"')
		expect(html).toContain('stroke="currentColor"')
	}
})
