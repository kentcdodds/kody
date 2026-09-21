import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { landingHomePrimitives } from '#universal/landing-home-copy.ts'
import { landingPrimitiveIds } from '#universal/landing-lantern.ts'
import { ensureOgBinaryAssetsReady } from '#worker/og/og-image-assets.ts'
import { getOgPalette } from '#worker/og/palette.ts'
import { type SatoriChild, type SatoriElement } from '#worker/og/render.ts'
import {
	createPrimitivesLantern,
	landingPrimitiveOgColors,
} from './primitives-lantern.ts'

/** Hue bands of the orb art. Pink/magenta is apps, not memory. */
const hueBands = {
	memory: [15, 45],
	secrets: [280, 320],
	packages: [230, 275],
	triggers: [80, 115],
	integrations: [125, 165],
	apps: [330, 360],
} as const

function hueOfHex(hex: string) {
	const r = Number.parseInt(hex.slice(1, 3), 16) / 255
	const g = Number.parseInt(hex.slice(3, 5), 16) / 255
	const b = Number.parseInt(hex.slice(5, 7), 16) / 255
	const lin = (channel: number) =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
	const red = lin(r)
	const green = lin(g)
	const blue = lin(b)
	const l = Math.cbrt(
		0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue,
	)
	const m = Math.cbrt(
		0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue,
	)
	const s = Math.cbrt(
		0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue,
	)
	const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
	const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
	const hue = (Math.atan2(bb, a) * 180) / Math.PI
	return hue < 0 ? hue + 360 : hue
}

function hueDelta(a: number, b: number) {
	const delta = Math.abs(a - b) % 360
	return Math.min(delta, 360 - delta)
}

function stylesheetHues() {
	const css = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '../../public/styles.css'),
		'utf8',
	)
	const hues = {
		light: {} as Record<(typeof landingPrimitiveIds)[number], number>,
		dark: {} as Record<(typeof landingPrimitiveIds)[number], number>,
	}
	for (const id of landingPrimitiveIds) {
		for (const theme of ['light', 'dark'] as const) {
			const name =
				theme === 'light' ? `--primitive-${id}` : `--primitive-${id}-dark`
			const match = css.match(new RegExp(`${name}:\\s*oklch\\(([^)]+)\\)`))
			if (!match?.[1]) throw new Error(`Missing ${name}`)
			const hue = Number(match[1].trim().split(/\s+/)[2])
			hues[theme][id] = hue
		}
	}
	return hues
}

function collectText(
	node: SatoriChild | Array<SatoriChild> | undefined,
): Array<string> {
	if (node == null) return []
	if (typeof node === 'string') return [node]
	if (Array.isArray(node)) return node.flatMap((child) => collectText(child))
	return collectText(node.props.children)
}

function countPaths(
	node: SatoriChild | Array<SatoriChild> | undefined,
): number {
	if (node == null || typeof node === 'string') return 0
	if (Array.isArray(node)) {
		return node.reduce((sum, child) => sum + countPaths(child), 0)
	}
	const self = node.type === 'path' ? 1 : 0
	return self + countPaths(node.props.children)
}

test('homepage OG lantern lists every primitive and draws a leader each', async () => {
	await ensureOgBinaryAssetsReady()
	const markup: SatoriElement = createPrimitivesLantern('dark')
	expect(collectText(markup)).toEqual(
		landingHomePrimitives.map((primitive) => primitive.word),
	)
	// Halo plus core stroke for each primitive.
	expect(countPaths(markup)).toBe(landingHomePrimitives.length * 2)
})

test('primitive leader colors follow the orb hues, not the old pink and lime', () => {
	const css = stylesheetHues()
	for (const id of landingPrimitiveIds) {
		const [min, max] = hueBands[id]
		for (const theme of ['light', 'dark'] as const) {
			expect(css[theme][id]).toBeGreaterThanOrEqual(min)
			expect(css[theme][id]).toBeLessThanOrEqual(max)
			const painted = hueOfHex(landingPrimitiveOgColors[theme][id])
			expect(hueDelta(painted, css[theme][id])).toBeLessThan(8)
		}
	}
	expect(hueDelta(css.light.memory, css.light.apps)).toBeGreaterThan(40)
	expect(hueDelta(css.light.triggers, css.light.integrations)).toBeGreaterThan(
		30,
	)
})

function collectByType(
	node: SatoriChild | Array<SatoriChild> | undefined,
	type: string,
): Array<SatoriElement> {
	if (node == null || typeof node === 'string') return []
	if (Array.isArray(node)) {
		return node.flatMap((child) => collectByType(child, type))
	}
	const self = node.type === type ? [node] : []
	return [...self, ...collectByType(node.props.children, type)]
}

test('a highlighted primitive rings its orb and accents only that word', async () => {
	await ensureOgBinaryAssetsReady()
	const plain = createPrimitivesLantern('dark')
	const triggers = createPrimitivesLantern('dark', 'triggers')
	expect(collectByType(plain, 'circle')).toEqual([])
	const circles = collectByType(triggers, 'circle')
	expect(circles.map((circle) => circle.props.stroke)).toEqual([
		landingPrimitiveOgColors.dark.triggers,
		landingPrimitiveOgColors.dark.triggers,
	])
	expect(collectText(triggers)).toEqual(
		landingHomePrimitives.map((primitive) => primitive.word),
	)
	const labels = new Map<string, string>()
	for (const node of collectByType(triggers, 'div')) {
		const text = node.props.children
		const color = node.props.style?.color
		if (typeof text === 'string' && typeof color === 'string') {
			labels.set(text, color)
		}
	}
	expect(labels.get('triggers')).toBe(landingPrimitiveOgColors.dark.triggers)
	expect(labels.get('memory')).toBe(getOgPalette('dark').textMuted)
})
