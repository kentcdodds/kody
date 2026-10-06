import {
	landingLanternGlass,
	landingLanternImage,
	landingLanternOrbs,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/**
 * World layout of the 3D lantern. One unit is the leader-fade radius of the
 * homepage still (`landingLanternGlass.r` of its width) and the origin is
 * the glass centre, so the model lines up with the 2D lantern it fades in
 * over and the leader mask keeps its circle. Part sizes are measured off
 * that still as fractions of its width and height.
 */

const stillAspect = landingLanternImage.height / landingLanternImage.width

/** The still's box in world units. */
export const lanternStill = {
	width: 1 / landingLanternGlass.r,
	height: stillAspect / landingLanternGlass.r,
} as const

/** World x and y for a point on the still, as fractions of its box. */
function stillToWorld(fx: number, fy: number) {
	return {
		x: (fx - landingLanternGlass.x) * lanternStill.width,
		y: (landingLanternGlass.y - fy) * lanternStill.height,
	}
}

const atHeight = (fy: number) => stillToWorld(0.5, fy).y
const ofWidth = (fraction: number) => fraction * lanternStill.width

export const lanternShape = {
	glassRadius: ofWidth(0.483),
	capBottom: atHeight(0.3),
	capTop: atHeight(0.205),
	capRadius: ofWidth(0.3),
	lidTop: atHeight(0.168),
	lidRadius: ofWidth(0.2),
	/** Outer edge of the handle arch. */
	handleTop: atHeight(0.01),
	handleReach: ofWidth(0.317),
	handleBand: ofWidth(0.052),
	baseTop: atHeight(0.8),
	baseBottom: atHeight(0.97),
	baseRadius: ofWidth(0.44),
	baseFoot: ofWidth(0.4),
} as const

export const lanternOrbRadius = ofWidth(landingLanternOrbs[0]!.size / 200)

/**
 * Where an orb centre may go: inside the glass wall, under the cap, and
 * over the base. The sphere and the band are in the lantern's own frame.
 */
export const lanternCavity = {
	radius: lanternShape.glassRadius - 0.07,
	top: lanternShape.capBottom,
	bottom: lanternShape.baseTop,
} as const

/**
 * Where each orb rests, in the lantern's own frame: x to the right, y up,
 * and z toward you while the lantern faces you. The heights step down in
 * the order the words are listed, so each leader runs to its own word
 * without crossing another. Side to side and front to back they alternate,
 * so none overlap face-on or after a half turn, and turning the lantern
 * shows how deep the globe is.
 */
export const lanternOrbHomes: ReadonlyArray<{
	id: LandingPrimitiveId
	x: number
	y: number
	z: number
}> = [
	{ id: 'memory', x: -0.2, y: 0.55, z: -0.2 },
	{ id: 'secrets', x: 0.56, y: 0.323, z: 0.12 },
	{ id: 'packages', x: -0.58, y: 0.096, z: 0.26 },
	{ id: 'triggers', x: 0.54, y: -0.131, z: -0.3 },
	{ id: 'integrations', x: -0.5, y: -0.358, z: -0.12 },
	{ id: 'apps', x: 0.26, y: -0.585, z: 0.22 },
]
