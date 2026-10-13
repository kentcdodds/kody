import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { LandingPrimitiveCards } from './landing-primitive-cards.tsx'

test('homepage cards link each primitive and keep the widgets decorative', async () => {
	const html = await renderToString(jsx(LandingPrimitiveCards, {}))

	expect(html.match(/class="landing-pcard"/g)?.length).toBeGreaterThan(0)
	expect(html).toMatch(/href="\/features\/[a-z-]+"/)
	expect(html.match(/data-size="mini"/g)?.length).toBeGreaterThan(0)
	expect(
		html.match(
			/<div[^>]*class="pw [^>]*aria-hidden="true"|<div[^>]*aria-hidden="true"[^>]*class="pw /g,
		)?.length,
	).toBeGreaterThan(0)
	// The card is the link, so a mini scene has nothing else to focus.
	expect(html).not.toContain('<button')
	// Motion is client-only: the server sends the finished still.
	expect(html).not.toContain('data-motion')
	expect(html).toContain('href="/features"')
})
