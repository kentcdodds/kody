import { type LandingHomePrimitive } from '#universal/landing-home-copy.ts'

/**
 * Five-orb lantern for the homepage primitives section. The shell (frame,
 * glass, and glow) and each primitive orb are separate layers, keyed to a
 * `landingHomePrimitives` id so the copy stays the single source of words
 * and definitions. Orb centres are percentages of the shell. Colors live in
 * `styles.css` as `--primitive-<id>` so the orbit lights and the leader
 * lines share one palette.
 */

export type LandingPrimitiveId = LandingHomePrimitive['id']

export const landingPrimitiveIds = [
	'memory',
	'secrets',
	'packages',
	'jobs',
	'integrations',
] as const satisfies ReadonlyArray<LandingPrimitiveId>

/** Empty lantern: frame, glass, and glow, with no colored orbs. */
export const landingLanternImage = {
	src: '/images/lantern/kody-primitives-lantern-shell-480.webp',
	srcSet: [
		'/images/lantern/kody-primitives-lantern-shell-480.webp 480w',
		'/images/lantern/kody-primitives-lantern-shell.webp 863w',
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
	jobs: '/images/lantern/kody-primitives-orb-jobs.webp',
	integrations: '/images/lantern/kody-primitives-orb-integrations.webp',
} as const satisfies Record<LandingPrimitiveId, string>

/** Glass globe in the shell: centre as fractions of width and height,
 *  radius as a fraction of width. Used to fade leaders inside the glass. */
export const landingLanternGlass = { x: 0.5, y: 0.545, r: 0.46 } as const

/**
 * Orb centres (percent of width and height), shared disc diameter (percent
 * of width), and sprite width (percent of width). Every hotspot is the
 * packages disc, so memory matches packages and the glyph stays in the
 * middle of its glow while the layer moves. `art` is larger than `size`
 * so the transparent glow around the disc is not clipped.
 */
export const landingLanternOrbs = [
	{ id: 'memory', x: 50.1, y: 43.9, size: 22.8, art: 24.03 },
	{ id: 'secrets', x: 25.7, y: 53.3, size: 22.8, art: 23.94 },
	{ id: 'packages', x: 74.9, y: 54.3, size: 22.8, art: 23.84 },
	{ id: 'jobs', x: 35.4, y: 68.3, size: 22.8, art: 23.84 },
	{ id: 'integrations', x: 67.2, y: 69.6, size: 22.8, art: 23.66 },
] as const satisfies ReadonlyArray<{
	id: LandingPrimitiveId
	x: number
	y: number
	size: number
	art: number
}>

/** CSS custom property that carries a primitive's color. */
export function landingPrimitiveColorVar(id: LandingPrimitiveId) {
	return `var(--primitive-${id})`
}

/** Palette tone for the nth orbit light; cycles through the five colors. */
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
