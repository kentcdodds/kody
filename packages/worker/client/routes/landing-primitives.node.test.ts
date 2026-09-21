import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { LandingPrimitives } from './landing-primitives.tsx'
import {
	landingHomePrimitives,
	landingPrimitivesMoreLink,
} from '#universal/landing-home-copy.ts'
import {
	landingLanternOrbClipPath,
	landingLanternOrbs,
} from '#universal/landing-lantern.ts'

test('primitives sentence pairs lantern orbs with words and ships empty leaders', async () => {
	const html = await renderToString(jsx(LandingPrimitives, {}))

	expect(html).toContain('id="primitives"')
	expect(html).toContain('href="/docs"')
	expect(html.match(/role="tooltip"/g)).toHaveLength(
		landingHomePrimitives.length,
	)
	expect(html.match(/class="landing-lantern-orb"/g)).toHaveLength(
		landingLanternOrbs.length,
	)
	expect(html.match(/aria-expanded="false"/g)).toHaveLength(
		landingHomePrimitives.length * 2,
	)
	expect(html).toContain('kody-primitives-lantern-480.webp')
	expect(html).toContain('kody-primitives-lantern.webp 863w')
	expect(html).not.toContain('kody-primitives-lantern-frame')
	expect(html).not.toContain('landing-lantern-frame')
	expect(html).toContain(`clip-path: ${landingLanternOrbClipPath()}`)
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
		expect(html).toContain(`>${primitive.word}<`)
		expect(html).toContain(primitive.body)
		expect(html).toContain(`data-word="${primitive.id}"`)
		expect(html).toContain(`data-orb="${primitive.id}"`)
		expect(html).toContain(`data-orb-art="${primitive.id}"`)
		expect(html).toContain(`data-primitive="${primitive.id}"`)
		expect(html).toContain(`aria-label="${primitive.word} primitive"`)
		expect(html).toContain(
			`--primitive-color: var(--primitive-${primitive.id})`,
		)
		const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map(
			(match) => match[1],
		)
		const panelIds = controls.filter((id) =>
			id?.endsWith(`-${primitive.id}-panel`),
		)
		expect(panelIds).toHaveLength(2)
		expect(new Set(panelIds).size).toBe(1)
		expect(html).toContain(`id="${panelIds[0]}"`)
	}

	expect(html.match(/data-dot="/g)).toHaveLength(landingHomePrimitives.length)
	expect(html.match(/class="landing-leader"/g)).toHaveLength(
		landingHomePrimitives.length,
	)
	// Paths are written from layout on the client; SSR paints nothing.
	expect(html).not.toMatch(/class="landing-leader-flow"[^>]*\sd="/)
	expect(html).not.toContain('data-dismissed')
	expect(html).not.toContain('data-active')
	expect(html).toContain(
		'Subscriptions, emails, webhooks, and schedules that wake packages you own — no chat left open.',
	)
	expect(
		html.replace(
			'Subscriptions, emails, webhooks, and schedules that wake packages you own — no chat left open.',
			'',
		),
	).not.toContain('\u2014')
})
