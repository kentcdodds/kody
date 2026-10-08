import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { landingPrimitiveIds } from '#universal/landing-lantern.ts'
import { parseCssColor, type LinearRgb } from './lantern-3d-color.ts'

function toBytes(rgb: LinearRgb | null) {
	if (!rgb) throw new Error('expected a color')
	return rgb.map((channel) => {
		const encoded =
			channel <= 0.0031308
				? channel * 12.92
				: 1.055 * channel ** (1 / 2.4) - 0.055
		return Math.round(encoded * 255)
	})
}

/** OKLab lightness, chroma, and hue of a linear sRGB color (Ottosson). */
function toOklch([r, g, b]: LinearRgb) {
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
	const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
	const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
	const hue = (Math.atan2(bb, a) * 180) / Math.PI
	return {
		lightness: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		chroma: Math.hypot(a, bb),
		hue: hue < 0 ? hue + 360 : hue,
	}
}

function hueDelta(a: number, b: number) {
	const delta = Math.abs(a - b) % 360
	return Math.min(delta, 360 - delta)
}

test('css colors become linear sRGB for WebGL, in the forms the palette uses', () => {
	// CSS Color 4 reference values for the sRGB primaries.
	expect(toBytes(parseCssColor('oklch(0.627955 0.257683 29.2339)'))).toEqual([
		255, 0, 0,
	])
	expect(
		toBytes(parseCssColor('oklch(86.6440% 0.294827 142.4953deg)')),
	).toEqual([0, 255, 0])
	expect(
		toBytes(parseCssColor('OKLCH(0.452014 0.313214 264.052 / 0.5)')),
	).toEqual([0, 0, 255])
	expect(toBytes(parseCssColor('oklch(1 0 none)'))).toEqual([255, 255, 255])
	expect(toBytes(parseCssColor('#f13b2e'))).toEqual([241, 59, 46])
	expect(toBytes(parseCssColor('#fc0'))).toEqual([255, 204, 0])
	expect(toBytes(parseCssColor('rgb(10, 20, 30)'))).toEqual([10, 20, 30])
	expect(toBytes(parseCssColor('rgb(100% 50% 0% / 40%)'))).toEqual([
		255, 128, 0,
	])

	for (const unreadable of [
		'var(--primitive-memory)',
		'oklch(0.5 0.1)',
		'hsl(0 100% 50%)',
		'#12345',
		'oklch(0.5 0.1 12parsecs)',
	]) {
		expect(parseCssColor(unreadable)).toBeNull()
	}
})

test('out-of-gamut orb colors keep their hue and give up chroma', () => {
	const vivid = parseCssColor('oklch(0.72 0.4 345)')
	if (!vivid) throw new Error('expected a color')
	for (const channel of vivid) {
		expect(channel).toBeGreaterThanOrEqual(0)
		expect(channel).toBeLessThanOrEqual(1)
	}
	const mapped = toOklch(vivid)
	expect(hueDelta(mapped.hue, 345)).toBeLessThan(1.5)
	expect(mapped.lightness).toBeCloseTo(0.72, 2)
	expect(mapped.chroma).toBeLessThan(0.4)
	expect(mapped.chroma).toBeGreaterThan(0.15)
})

test('every primitive in the stylesheet reads as its own hue in both themes', () => {
	const css = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '../../public/styles.css'),
		'utf8',
	)
	for (const id of landingPrimitiveIds) {
		for (const name of [`--primitive-${id}`, `--primitive-${id}-dark`]) {
			const declared = css.match(new RegExp(`${name}:\\s*(oklch\\([^)]+\\))`))
			if (!declared?.[1]) throw new Error(`Missing ${name}`)
			const hue = Number(declared[1].slice(6, -1).trim().split(/\s+/)[2])
			const rgb = parseCssColor(declared[1])
			if (!rgb) throw new Error(`Unreadable ${name}`)
			expect(hueDelta(toOklch(rgb).hue, hue)).toBeLessThan(3)
		}
	}
})
