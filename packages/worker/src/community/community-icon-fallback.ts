/**
 * Deterministic package-icon fallbacks for listings without community-icon.*.
 *
 * Taste is the constraint. A hash must never produce neon sludge, complementary
 * overlays, or high-chroma brown/olive. Every icon draws from a hand-tuned
 * analogous palette (wash + two ribbons + a deep ink) and the same spiral
 * composition, so the set reads as one designed family instead of random art.
 *
 * Soft overlapping color fields are a common generative-identicon idea — see
 * boring-avatars "marble" (MIT,
 * https://github.com/boringdesigners/boring-avatars). The spiral ribbons and
 * palettes here are original.
 */

export const communityIconFallbackArtVersion = 1 as const

type FallbackPalette = {
	id: string
	wash: string
	ribbon: string
	accent: string
	ink: string
}

/**
 * Mid-chroma, high-wash families. Hue spans stay under ~40° so ribbons cannot
 * mix into mud. No neon, no complementary pairs.
 */
export const communityIconFallbackPalettes = [
	{
		id: 'dusk',
		wash: '#eee8f6',
		ribbon: '#7d6bb3',
		accent: '#c4a8d8',
		ink: '#3d3560',
	},
	{
		id: 'sea',
		wash: '#e6f1f3',
		ribbon: '#3d8b9a',
		accent: '#86c0c8',
		ink: '#1e4d56',
	},
	{
		id: 'lichen',
		wash: '#e8f1e6',
		ribbon: '#5a8f6a',
		accent: '#a8c9a4',
		ink: '#2d4a34',
	},
	{
		id: 'apricot',
		wash: '#f7eee6',
		ribbon: '#c98468',
		accent: '#e4b89a',
		ink: '#6b3d32',
	},
	{
		id: 'fog',
		wash: '#eceef2',
		ribbon: '#6b7c94',
		accent: '#a8b4c4',
		ink: '#2e3848',
	},
	{
		id: 'lilac',
		wash: '#f2e8f4',
		ribbon: '#8b6ba8',
		accent: '#c9b0d8',
		ink: '#3e2d52',
	},
	{
		id: 'inkwell',
		wash: '#e6eef4',
		ribbon: '#3d6b8a',
		accent: '#86adc0',
		ink: '#1c3344',
	},
	{
		id: 'sand',
		wash: '#f4efe6',
		ribbon: '#a88464',
		accent: '#d4c0a4',
		ink: '#5c4634',
	},
] as const satisfies ReadonlyArray<FallbackPalette>

const tileSize = 256
const tileRadius = 56
const spiralSamples = 22

export function hashCommunityIconSeed(name: string) {
	let hash = 2166136261
	for (const character of name) {
		hash ^= character.charCodeAt(0)
		hash = Math.imul(hash, 16777619)
	}
	return hash >>> 0
}

function mulberry32(seed: number) {
	let state = seed >>> 0
	return function next() {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

export function pickCommunityIconFallbackPalette(name: string) {
	const palettes = communityIconFallbackPalettes
	return palettes[hashCommunityIconSeed(name) % palettes.length] ?? palettes[0]
}

function formatNumber(value: number) {
	return value.toFixed(2)
}

function spiralPoints(input: {
	cx: number
	cy: number
	innerRadius: number
	outerRadius: number
	turns: number
	phase: number
}) {
	const points: Array<[number, number]> = []
	for (let index = 0; index < spiralSamples; index += 1) {
		const t = index / (spiralSamples - 1)
		const theta = input.phase + t * input.turns * Math.PI * 2
		const radius =
			input.outerRadius + (input.innerRadius - input.outerRadius) * t
		points.push([
			input.cx + radius * Math.cos(theta),
			input.cy + radius * Math.sin(theta),
		])
	}
	return points
}

function pointsToPath(points: ReadonlyArray<[number, number]>) {
	const first = points[0]
	if (!first) return ''
	let path = `M${formatNumber(first[0])} ${formatNumber(first[1])}`
	for (let index = 1; index < points.length - 1; index += 1) {
		const current = points[index]
		const next = points[index + 1]
		if (!current || !next) continue
		path += ` Q${formatNumber(current[0])} ${formatNumber(current[1])} ${formatNumber((current[0] + next[0]) / 2)} ${formatNumber((current[1] + next[1]) / 2)}`
	}
	const last = points[points.length - 1]
	if (last) path += ` T${formatNumber(last[0])} ${formatNumber(last[1])}`
	return path
}

function ellipse(input: {
	cx: number
	cy: number
	rx: number
	ry: number
	rotate: number
	fill: string
	opacity: number
}) {
	return `<ellipse cx="${formatNumber(input.cx)}" cy="${formatNumber(input.cy)}" rx="${formatNumber(input.rx)}" ry="${formatNumber(input.ry)}" fill="${input.fill}" opacity="${formatNumber(input.opacity)}" transform="rotate(${formatNumber(input.rotate)} ${formatNumber(input.cx)} ${formatNumber(input.cy)})"/>`
}

function ribbon(input: {
	d: string
	color: string
	width: number
	opacity: number
}) {
	return `<path d="${input.d}" fill="none" stroke="${input.color}" stroke-width="${formatNumber(input.width)}" stroke-linecap="round" stroke-linejoin="round" opacity="${formatNumber(input.opacity)}"/>`
}

export function buildCommunityIconFallbackSvg(name: string) {
	const seed = hashCommunityIconSeed(name)
	const random = mulberry32(seed)
	const palette = pickCommunityIconFallbackPalette(name)
	const id = seed.toString(16)
	const cx = 118 + random() * 20
	const cy = 118 + random() * 20
	const phase = random() * Math.PI * 2
	const turns = 1.65 + random() * 0.55
	const wide = ribbon({
		d: pointsToPath(
			spiralPoints({
				cx,
				cy,
				innerRadius: 18,
				outerRadius: 118,
				turns,
				phase,
			}),
		),
		color: palette.ribbon,
		width: 38,
		opacity: 0.78,
	})
	const mid = ribbon({
		d: pointsToPath(
			spiralPoints({
				cx: cx + 10,
				cy: cy - 8,
				innerRadius: 14,
				outerRadius: 102,
				turns: turns - 0.18,
				phase: phase + 0.9,
			}),
		),
		color: palette.accent,
		width: 28,
		opacity: 0.62,
	})
	const fine = ribbon({
		d: pointsToPath(
			spiralPoints({
				cx: cx - 6,
				cy: cy + 12,
				innerRadius: 10,
				outerRadius: 86,
				turns: turns + 0.22,
				phase: phase + 2.1,
			}),
		),
		color: palette.ink,
		width: 16,
		opacity: 0.4,
	})
	const wash = `<linearGradient id="wash-${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette.wash}"/><stop offset="1" stop-color="${palette.accent}" stop-opacity="0.38"/></linearGradient>`
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${tileSize}" height="${tileSize}" viewBox="0 0 ${tileSize} ${tileSize}" data-fallback-art="${communityIconFallbackArtVersion}" data-palette="${palette.id}">`,
		`<defs><clipPath id="tile-${id}"><rect width="${tileSize}" height="${tileSize}" rx="${tileRadius}"/></clipPath>${wash}</defs>`,
		`<g clip-path="url(#tile-${id})">`,
		`<rect width="${tileSize}" height="${tileSize}" fill="url(#wash-${id})"/>`,
		ellipse({
			cx: 70 + random() * 30,
			cy: 78 + random() * 24,
			rx: 86,
			ry: 62,
			rotate: random() * 50 - 25,
			fill: palette.ribbon,
			opacity: 0.22,
		}),
		ellipse({
			cx: 176 + random() * 24,
			cy: 168 + random() * 22,
			rx: 78,
			ry: 54,
			rotate: random() * 40 - 20,
			fill: palette.accent,
			opacity: 0.28,
		}),
		wide,
		mid,
		fine,
		`</g></svg>`,
	].join('')
}
