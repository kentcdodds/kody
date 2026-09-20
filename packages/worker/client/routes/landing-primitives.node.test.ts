import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { LandingPrimitives } from './landing-primitives.tsx'
import {
	landingHomePrimitives,
	landingPrimitivesMoreLink,
} from '#universal/landing-home-copy.ts'

test('primitives sentence renders dash-underlined disclosures and the what-is-Kody link', async () => {
	const html = await renderToString(jsx(LandingPrimitives, {}))

	expect(html).toContain('id="primitives"')
	expect(html).toContain('shared set of primitives')
	expect(html).toContain('href="/docs"')
	expect(html).toContain(landingPrimitivesMoreLink)
	expect(html).toContain('role="tooltip"')
	expect(html.match(/role="tooltip"/g)).toHaveLength(
		landingHomePrimitives.length,
	)
	expect(html.match(/aria-expanded="false"/g)).toHaveLength(
		landingHomePrimitives.length,
	)

	for (const primitive of landingHomePrimitives) {
		expect(html).toContain(`>${primitive.word}<`)
		expect(html).toContain(primitive.body)
		expect(html).toContain('aria-controls=')
		expect(html).toContain('aria-describedby=')
	}

	expect(html).toContain('landing-primitive-word')
	expect(html).not.toContain('\u2014')
})
