import { type LandingHomePrimitive } from '#universal/landing-home-copy.ts'

/**
 * Six-orb lantern for the homepage primitives section. The lantern is one
 * still (glass, glow, and metal together). Each primitive orb is an overlay
 * clipped to the opening inside the frame, keyed to a `landingHomePrimitives`
 * id so the copy stays the single source of words and definitions. Orb
 * centres are percentages of that still. Colors live in `styles.css` as
 * `--primitive-<id>` so the orbit lights and the leader lines share one
 * palette.
 */

export type LandingPrimitiveId = LandingHomePrimitive['id']

export const landingPrimitiveIds = [
	'memory',
	'secrets',
	'packages',
	'triggers',
	'integrations',
	'apps',
] as const satisfies ReadonlyArray<LandingPrimitiveId>

/** The whole lantern. Metal and glass stay in one image so the frame edge
 *  cannot open a seam against the page. */
export const landingLanternImage = {
	src: '/images/lantern/kody-primitives-lantern-480.webp',
	srcSet: [
		'/images/lantern/kody-primitives-lantern-480.webp 480w',
		'/images/lantern/kody-primitives-lantern.webp 863w',
	].join(', '),
	sizes: '(max-width: 800px) 58vw, 17rem',
	width: 863,
	height: 1242,
} as const

/** Orb cutouts. Each sprite is centered on its disc in the shell. */
export const landingLanternOrbArt = {
	memory: '/images/lantern/kody-primitives-orb-memory.webp',
	secrets: '/images/lantern/kody-primitives-orb-secrets.webp',
	packages: '/images/lantern/kody-primitives-orb-packages.webp',
	triggers: '/images/lantern/kody-primitives-orb-triggers.webp',
	integrations: '/images/lantern/kody-primitives-orb-integrations.webp',
	apps: '/images/lantern/kody-primitives-orb-apps.webp',
} as const satisfies Record<LandingPrimitiveId, string>

/** Glass globe in the shell: centre as fractions of width and height,
 *  radius as a fraction of width. Used to fade leaders inside the glass. */
export const landingLanternGlass = { x: 0.5, y: 0.545, r: 0.46 } as const

/**
 * Underside of the cap and top of the base, as fractions of the lantern.
 * Sampled along the metal where it meets the glass. The orb clip follows
 * these lips, and the glass ellipse everywhere the metal does not cut in.
 */
const landingLanternCapLip = [
	[0.2, 0.246],
	[0.225, 0.305],
	[0.25, 0.307],
	[0.275, 0.297],
	[0.3, 0.289],
	[0.324, 0.291],
	[0.35, 0.299],
	[0.375, 0.304],
	[0.4, 0.31],
	[0.425, 0.312],
	[0.45, 0.312],
	[0.475, 0.315],
	[0.501, 0.314],
	[0.525, 0.312],
	[0.55, 0.311],
	[0.575, 0.307],
	[0.6, 0.299],
	[0.625, 0.305],
	[0.65, 0.304],
	[0.676, 0.303],
	[0.7, 0.297],
	[0.725, 0.294],
	[0.75, 0.298],
	[0.775, 0.303],
	[0.8, 0.245],
] as const satisfies ReadonlyArray<readonly [number, number]>

const landingLanternBaseLip = [
	[0.2, 0.831],
	[0.225, 0.836],
	[0.25, 0.839],
	[0.275, 0.841],
	[0.3, 0.841],
	[0.324, 0.842],
	[0.35, 0.841],
	[0.375, 0.842],
	[0.4, 0.842],
	[0.425, 0.843],
	[0.45, 0.844],
	[0.475, 0.845],
	[0.501, 0.844],
	[0.525, 0.844],
	[0.55, 0.845],
	[0.575, 0.848],
	[0.6, 0.843],
	[0.625, 0.846],
	[0.65, 0.841],
	[0.676, 0.84],
	[0.7, 0.837],
	[0.725, 0.835],
	[0.75, 0.833],
	[0.775, 0.829],
	[0.8, 0.827],
] as const satisfies ReadonlyArray<readonly [number, number]>

/** Keep the clip just inside the metal pixel the lip was measured on. */
const landingLanternLipInset = 0.004

/**
 * Orb centres (percent of width and height), shared disc diameter (percent
 * of width), and sprite width (percent of width). `size` is the painted
 * disc, so the hotspot, ring, collision radius, and leader rim match it.
 * `art` is the slightly larger sprite, cropped so that disc sits in the
 * middle of the image. Six discs at 16.2 stay inside the glass with room
 * to drift.
 */
export const landingLanternOrbs = [
	{ id: 'memory', x: 50, y: 38.5, size: 16.2, art: 16.94 },
	{ id: 'secrets', x: 29, y: 50, size: 16.2, art: 16.94 },
	{ id: 'packages', x: 71, y: 50, size: 16.2, art: 16.95 },
	{ id: 'triggers', x: 34, y: 63, size: 16.2, art: 16.94 },
	{ id: 'integrations', x: 66, y: 63, size: 16.2, art: 16.93 },
	{ id: 'apps', x: 50, y: 74.5, size: 16.2, art: 16.91 },
] as const satisfies ReadonlyArray<{
	id: LandingPrimitiveId
	x: number
	y: number
	size: number
	art: number
}>

/**
 * Clip for the orb overlay. The sprite halo, pulse ring, and hover bloom
 * paint with the discs, so the clip is the glass opening: under the cap,
 * above the base, and inside the globe. It follows the metal where the
 * frame cuts into the glass, and the glass ellipse on the bare sides.
 */
export function landingLanternOrbClipPath() {
	const { width, height } = landingLanternImage
	const rx = landingLanternGlass.r
	const ry = landingLanternGlass.r * (width / height)
	const { x: cx, y: cy } = landingLanternGlass
	const samples = 36
	const top: Array<readonly [number, number]> = []
	const bottom: Array<readonly [number, number]> = []
	for (let index = 0; index <= samples; index++) {
		const x = cx - rx + (2 * rx * index) / samples
		const nx = (x - cx) / rx
		const span = Math.sqrt(Math.max(0, 1 - nx * nx)) * ry
		const ellipseTop = cy - span
		const ellipseBottom = cy + span
		const cap = lipAt(landingLanternCapLip, x)
		const base = lipAt(landingLanternBaseLip, x)
		const yTop = Math.max(
			ellipseTop,
			cap == null ? ellipseTop : cap + landingLanternLipInset,
		)
		const yBottom = Math.min(
			ellipseBottom,
			base == null ? ellipseBottom : base - landingLanternLipInset,
		)
		if (yBottom - yTop < 0.01) continue
		top.push([x, yTop])
		bottom.push([x, yBottom])
	}
	const points = [...top, ...bottom.reverse()]
	const percent = (value: number) => `${Math.round(value * 1000) / 10}%`
	return `polygon(${points
		.map(([x, y]) => `${percent(x)} ${percent(y)}`)
		.join(',')})`
}

function lipAt(samples: ReadonlyArray<readonly [number, number]>, x: number) {
	const first = samples[0]
	const last = samples[samples.length - 1]
	if (!first || !last || x < first[0] || x > last[0]) return null
	for (let index = 1; index < samples.length; index++) {
		const previous = samples[index - 1]!
		const current = samples[index]!
		if (x > current[0]) continue
		const span = current[0] - previous[0]
		const t = span === 0 ? 0 : (x - previous[0]) / span
		return previous[1] + (current[1] - previous[1]) * t
	}
	return last[1]
}

/** CSS custom property that carries a primitive's color. */
export function landingPrimitiveColorVar(id: LandingPrimitiveId) {
	return `var(--primitive-${id})`
}

/** Palette tone for the nth orbit light; cycles through the six colors. */
export function landingOrbitLightTone(index: number): LandingPrimitiveId {
	const count = landingPrimitiveIds.length
	return landingPrimitiveIds[((index % count) + count) % count]!
}

export type LandingLeaderPoint = { x: number; y: number }

/**
 * Cubic from an orb to the word's dot with horizontal tangents at both
 * ends: it leaves the glass sideways and glides into the dot from the
 * left. Coordinates are pixels relative to the stage; the SVG's viewBox is
 * set to the stage size so units map one to one.
 */
export function landingLeaderPath(
	from: LandingLeaderPoint,
	to: LandingLeaderPoint,
) {
	const dx = to.x - from.x
	const reach = Math.max(Math.abs(dx) * 0.5, 24)
	const c1 = { x: from.x + reach, y: from.y }
	const c2 = { x: to.x - reach * 0.6, y: to.y }
	return `M${round(from.x)} ${round(from.y)} C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(to.x)} ${round(to.y)}`
}

/** Word anchor: the left edge of the colored dot before the word. */
export function landingLeaderWordAnchor(
	rect: { left: number; top: number; height: number },
	origin: { left: number; top: number },
): LandingLeaderPoint {
	return {
		x: rect.left - origin.left - 2,
		y: rect.top + rect.height / 2 - origin.top,
	}
}

/** Orb anchor: the orb's centre. */
export function landingLeaderOrbAnchor(
	rect: { left: number; top: number; width: number; height: number },
	origin: { left: number; top: number },
): LandingLeaderPoint {
	return {
		x: rect.left + rect.width / 2 - origin.left,
		y: rect.top + rect.height / 2 - origin.top,
	}
}

/**
 * Where a leader leaves the orb: on the painted orb's rim, facing the
 * word, so the line does not cross the orb's own face. `radius` is the
 * hotspot radius; the painted orb sits just inside it.
 */
export function landingLeaderOrbExit(
	centre: LandingLeaderPoint,
	to: LandingLeaderPoint,
	radius: number,
): LandingLeaderPoint {
	const dx = to.x - centre.x
	const dy = to.y - centre.y
	const length = Math.hypot(dx, dy)
	if (length === 0) return centre
	const rim = radius * 0.86
	return {
		x: centre.x + (dx / length) * rim,
		y: centre.y + (dy / length) * rim,
	}
}

function round(value: number) {
	return Math.round(value * 10) / 10
}
