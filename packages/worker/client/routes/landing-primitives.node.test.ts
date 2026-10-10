import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { LandingPrimitives } from './landing-primitives.tsx'
import {
	landingHomePrimitives,
	landingPrimitivesMoreLink,
} from '#universal/landing-home-copy.ts'
import { landingLanternOrbs } from '#universal/landing-lantern.ts'

test('primitives sentence pairs lantern orbs with words and ships empty leaders', async () => {
	const html = await renderToString(jsx(LandingPrimitives, {}))

	expect(html).toContain('id="primitives"')
	expect(html).toContain('href="/features"')
	expect(html).not.toContain('role="tooltip"')
	expect(html.match(/class="landing-lantern-orb"/g)).toHaveLength(
		landingLanternOrbs.length,
	)
	expect(html).not.toContain('aria-expanded')
	expect(html).not.toContain('aria-controls')
	expect(html).toContain('kody-primitives-lantern-480.webp')
	expect(html).toContain('kody-primitives-lantern.webp 863w')
	expect(html).toContain('clip-path: polygon(')
	expect(html.match(/class="landing-lantern-orb-art"/g)).toHaveLength(
		landingLanternOrbs.length,
	)
	expect(html.indexOf('id="primitives-title"')).toBeLessThan(
		html.indexOf('landing-lantern'),
	)
	expect(html.indexOf('landing-primitives-words')).toBeLessThan(
		html.indexOf(landingPrimitivesMoreLink),
	)

	for (const primitive of landingHomePrimitives) {
		expect(html).toContain(`href="/features/${primitive.id}"`)
		expect(html).toContain(`>${primitive.word}<`)
		expect(html).toContain(`data-word="${primitive.id}"`)
		expect(html).toContain(`data-orb="${primitive.id}"`)
		expect(html).toContain(`data-orb-art="${primitive.id}"`)
		expect(html).toContain(`data-primitive="${primitive.id}"`)
		expect(html).toContain(`aria-label="${primitive.word} primitive"`)
		expect(html).toContain(
			`--primitive-color: var(--primitive-${primitive.id})`,
		)
	}

	// Unitless so Firefox can divide art by size. Percentages need typed
	// arithmetic and the sprite falls back to its intrinsic box.
	for (const orb of landingLanternOrbs) {
		expect(html).toContain(`--size: ${orb.size};`)
		expect(html).toContain(`--art: ${orb.art};`)
	}

	expect(html.match(/data-dot="/g)).toHaveLength(landingHomePrimitives.length)
	expect(html.match(/class="landing-leader"/g)).toHaveLength(
		landingHomePrimitives.length,
	)
	// Paths are written from layout on the client; SSR paints nothing.
	expect(html).not.toMatch(/class="landing-leader-flow"[^>]*\sd="/)
	expect(html).not.toContain('data-dismissed')
	expect(html).not.toContain('data-active')
	for (const primitive of landingHomePrimitives) {
		expect(html).not.toContain(primitive.body)
	}
})
