/**
 * Primitive colors for the 3D lantern. The palette lives in `styles.css` as
 * `oklch()` custom properties, and WebGL wants linear sRGB. Colors outside
 * sRGB give up chroma rather than hue, close to how browsers map them, so
 * the orbs keep the same family as the words and leader lines.
 */

export type LinearRgb = readonly [r: number, g: number, b: number]

const gamutEpsilon = 1e-4

export function parseCssColor(input: string): LinearRgb | null {
	const value = input.trim().toLowerCase()
	if (value.startsWith('#')) return parseHex(value)
	const match = /^(oklch|rgba?)\((.*)\)$/.exec(value)
	if (!match) return null
	const channels = match[2]!.split('/')[0]!.replace(/,/g, ' ').trim()
	const parts = channels.split(/\s+/)
	if (parts.length !== 3) return null
	if (match[1] === 'oklch') {
		const lightness = parseAmount(parts[0]!, 1)
		const chroma = parseAmount(parts[1]!, 0.4)
		const hue = parseHue(parts[2]!)
		if (lightness === null || chroma === null || hue === null) return null
		return oklchToLinearSrgb(lightness, chroma, hue)
	}
	const [r, g, b] = parts.map((part) => parseAmount(part, 255))
	if (r == null || g == null || b == null) return null
	return [srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)]
}

/** `hue` in degrees. Reduces chroma until the color fits in sRGB. */
export function oklchToLinearSrgb(
	lightness: number,
	chroma: number,
	hue: number,
): LinearRgb {
	const l = clampUnit(lightness)
	const c = Math.max(chroma, 0)
	const exact = oklabToLinearSrgb(l, c, hue)
	if (inGamut(exact)) return clampRgb(exact)
	let low = 0
	let high = c
	for (let step = 0; step < 18; step++) {
		const mid = (low + high) / 2
		if (inGamut(oklabToLinearSrgb(l, mid, hue))) low = mid
		else high = mid
	}
	return clampRgb(oklabToLinearSrgb(l, low, hue))
}

function oklabToLinearSrgb(
	lightness: number,
	chroma: number,
	hue: number,
): LinearRgb {
	const radians = (hue * Math.PI) / 180
	const a = chroma * Math.cos(radians)
	const b = chroma * Math.sin(radians)
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	]
}

function inGamut(rgb: LinearRgb) {
	return rgb.every(
		(channel) => channel >= -gamutEpsilon && channel <= 1 + gamutEpsilon,
	)
}

function clampRgb(rgb: LinearRgb): LinearRgb {
	return [clampUnit(rgb[0]), clampUnit(rgb[1]), clampUnit(rgb[2])]
}

function clampUnit(value: number) {
	return Math.min(Math.max(value, 0), 1)
}

function srgbToLinear(channel: number) {
	const clamped = clampUnit(channel)
	return clamped <= 0.04045
		? clamped / 12.92
		: ((clamped + 0.055) / 1.055) ** 2.4
}

/** A bare number, or a percentage of `full`. */
function parseAmount(token: string, full: number) {
	if (token === 'none') return 0
	if (token.endsWith('%')) {
		const percent = Number(token.slice(0, -1))
		return Number.isFinite(percent) ? (percent / 100) * full : null
	}
	const number = Number(token)
	return Number.isFinite(number) ? number : null
}

function parseHue(token: string) {
	if (token === 'none') return 0
	const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|rad|grad|turn)?$/.exec(token)
	if (!match) return null
	const amount = Number(match[1])
	const unit = match[2] ?? 'deg'
	if (unit === 'rad') return (amount * 180) / Math.PI
	if (unit === 'grad') return amount * 0.9
	if (unit === 'turn') return amount * 360
	return amount
}

function parseHex(value: string): LinearRgb | null {
	const hex = value.slice(1)
	if (!/^[0-9a-f]+$/.test(hex)) return null
	let full: string
	if (hex.length === 3 || hex.length === 4) {
		full = Array.from(hex.slice(0, 3), (digit) => digit + digit).join('')
	} else if (hex.length === 6 || hex.length === 8) {
		full = hex.slice(0, 6)
	} else {
		return null
	}
	const channel = (offset: number) =>
		srgbToLinear(Number.parseInt(full.slice(offset, offset + 2), 16) / 255)
	return [channel(0), channel(2), channel(4)]
}
