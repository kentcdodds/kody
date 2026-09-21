import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { LandingPrimitives } from './landing-primitives.tsx'
import {
	landingHomePrimitives,
	landingPrimitivesMoreLink,
} from '#universal/landing-home-copy.ts'
import { landingLanternOrbs } from '#universal/landing-lantern.ts'

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

	for (const primitive of landingHomePrimitives) {
		expect(html).toContain(`>${primitive.word}<`)
		expect(html).toContain(primitive.body)
		expect(html).toContain(`data-word="${primitive.id}"`)
	}

	expect(html).toContain('landing-primitive-word')
	expect(html).toContain('id="primitives-title"')
	expect(html).toContain('landing-primitives-stage')
	expect(html).toContain('landing-primitives-words')
	expect(html.match(/data-dot="/g)).toHaveLength(landingHomePrimitives.length)
	expect(html.indexOf('id="primitives-title"')).toBeLessThan(
		html.indexOf('landing-lantern'),
	)
	expect(html.indexOf('landing-primitives-words')).toBeLessThan(
		html.indexOf(landingPrimitivesMoreLink),
	)
	expect(html).not.toContain('data-dismissed')
	expect(html).not.toContain('data-active')
	expect(html).not.toContain('\u2014')
})

test('lantern orbs and words are paired disclosures for one popover each', async () => {
	const html = await renderToString(jsx(LandingPrimitives, {}))

	expect(html).toContain('class="landing-lantern"')
	expect(html).toContain('kody-primitives-lantern-shell-480.webp')
	expect(html).toContain('kody-primitives-lantern-shell.webp 863w')
	expect(html.match(/class="landing-lantern-orb"/g)).toHaveLength(
		landingLanternOrbs.length,
	)
	expect(html.match(/class="landing-lantern-orb-art"/g)).toHaveLength(
		landingLanternOrbs.length,
	)
	for (const orb of landingLanternOrbs) {
		expect(html).toContain(`data-orb-art="${orb.id}"`)
	}
	// Every orb and every word is a collapsed disclosure that controls and
	// is described by the same tooltip id.
	expect(html.match(/aria-expanded="false"/g)).toHaveLength(
		landingHomePrimitives.length * 2,
	)
	for (const primitive of landingHomePrimitives) {
		expect(html).toContain(`data-orb="${primitive.id}"`)
		expect(html).toContain(`aria-label="${primitive.word} primitive"`)
		const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map(
			(match) => match[1],
		)
		const panelIds = controls.filter((id) =>
			id?.endsWith(`-${primitive.id}-panel`),
		)
		expect(panelIds).toHaveLength(2)
		expect(new Set(panelIds).size).toBe(1)
		expect(html).toContain(`id="${panelIds[0]}"`)
		expect(html).toContain(
			`--primitive-color: var(--primitive-${primitive.id})`,
		)
	}
})

test('leader overlay ships one empty group per primitive for the client to measure', async () => {
	const html = await renderToString(jsx(LandingPrimitives, {}))

	expect(html).toContain('class="landing-primitives-leaders"')
	expect(html.match(/class="landing-leader"/g)).toHaveLength(
		landingHomePrimitives.length,
	)
	for (const primitive of landingHomePrimitives) {
		expect(html).toContain(`data-primitive="${primitive.id}"`)
	}
	// Paths are written from layout on the client; SSR paints nothing.
	expect(html).not.toMatch(/class="landing-leader-flow"[^>]*\sd="/)
	expect(html).not.toContain('landing-hero-agent-line')
})
