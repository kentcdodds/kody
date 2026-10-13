import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { LandingPrimitiveCards } from './landing-primitive-cards.tsx'
import { primitiveCards } from '#universal/primitive-cards.ts'
import { landingPrimitiveIds } from '#universal/landing-lantern.ts'

test('homepage cards link each primitive and keep the widgets decorative', async () => {
	const html = await renderToString(jsx(LandingPrimitiveCards, {}))

	expect(primitiveCards.map((card) => card.id)).toEqual([
		...landingPrimitiveIds,
	])
	expect(html.match(/class="landing-pcard"/g)).toHaveLength(6)
	for (const card of primitiveCards) {
		expect(html).toContain(`href="/features/${card.id}"`)
		expect(html).toContain(`>${card.name}<`)
		expect(html).toContain(card.title)
		expect(html).toContain(`class="pw pw-${card.id}"`)
	}
	expect(html.match(/data-size="mini"/g)).toHaveLength(6)
	expect(
		html.match(
			/<div[^>]*class="pw [^>]*aria-hidden="true"|<div[^>]*aria-hidden="true"[^>]*class="pw /g,
		),
	).toHaveLength(6)
	// The card is the link, so a mini scene has nothing else to focus.
	expect(html).not.toContain('<button')
	// Motion is client-only: the server sends the finished still.
	expect(html).not.toContain('data-motion')
	expect(html).toContain('href="/features"')
})
