import {
	BufferAttribute,
	BufferGeometry,
	CatmullRomCurve3,
	CircleGeometry,
	Color,
	DirectionalLight,
	Group,
	LatheGeometry,
	Mesh,
	type MeshBasicMaterial,
	type MeshPhysicalMaterial,
	type MeshStandardMaterial,
	PlaneGeometry,
	PointLight,
	Points,
	type ShaderMaterial,
	SphereGeometry,
	Sprite,
	type SpriteMaterial,
	TorusGeometry,
	TubeGeometry,
	Vector2,
	Vector3,
} from 'three'
import {
	landingPrimitiveIds,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'
import {
	createConstellationThread,
	type ConstellationThread,
} from './lantern-3d-constellation.ts'
import { createGlyphGeometry } from './lantern-3d-glyphs.ts'
import {
	lanternCavity,
	lanternOrbRadius,
	lanternShape,
} from './lantern-3d-layout.ts'
import {
	createBurstMaterial,
	createFireflyMaterial,
	createGlassFloorMaterial,
	createGlassInteriorMaterial,
	createGlassReflectionMaterial,
	createGlassRimMaterial,
	createGlowMaterial,
	createGlowTexture,
	createGlyphMaterial,
	createKeylineMaterial,
	createLitEdgeMaterial,
	createMetalMaterial,
	createOrbCoreMaterial,
	createOrbShellMaterial,
	createPoolMaterial,
	createShadowMaterial,
	createSparkleMaterial,
	createThreadMaterial,
	lanternAmber,
} from './lantern-3d-materials.ts'
import { lanternLights } from './lantern-3d-studio.ts'

/**
 * The lantern as a scene graph, in the world units of lantern-3d-layout.ts.
 *
 * `root` holds the lantern and its lights and carries the slight downward
 * view of the still; `ground` carries the same view for the light it
 * throws. `lantern` is the glass and metal; it turns and tips. The orbs and
 * the fireflies sit in `root` directly because the motion code places them
 * in that frame. The sparkles sit in `fluid`, which tips with the lantern
 * and swirls in its shader.
 */

export type LanternOrbView = {
	id: LandingPrimitiveId
	group: Group
	/** Rolls with travel so the specks inside turn as the orb moves. */
	roll: Group
	/** Faces the viewer, looks toward the pointer, and spins when booped. */
	glyph: Group
	core: ShaderMaterial
	shell: MeshPhysicalMaterial
	glyphMaterial: MeshPhysicalMaterial
	keyline: MeshStandardMaterial
	halo: SpriteMaterial
}

type LanternBurst = {
	points: Points<BufferGeometry, ShaderMaterial>
	emit: (
		origin: Vector3,
		color: Color,
		options: { count: number; speed: number; time: number },
	) => void
}

export type LanternModel = {
	root: Group
	/** The light pool and contact shadow. They stay put while the lantern
	 *  bobs. */
	ground: Group
	lantern: Group
	handle: Group
	fluid: Group
	orbs: Array<LanternOrbView>
	glassInterior: ShaderMaterial
	glassFloor: ShaderMaterial
	sparkles: ShaderMaterial
	fireflies: ShaderMaterial
	burst: LanternBurst
	/** The idle constellation, orb to orb in word order. */
	thread: ConstellationThread
	aura: SpriteMaterial
	pool: MeshBasicMaterial
	shadow: MeshBasicMaterial
	innerLight: PointLight
	dispose: () => void
}

/** Runs one slice of startup, then yields. Rejects once startup is dropped. */
export type LanternStep = <T>(work: () => T | PromiseLike<T>) => Promise<T>

/** Above the still's horizon, as its cap and base rims show. */
const lanternViewPitch = 0.12

/** Hinge height of the handle, on top of the cap ring. */
const hingeY = lanternShape.capTop + 0.02

/** The base's top inside the glass, tucked under the metal lip. */
const floorRadius = 0.83

/**
 * The glass outline as radius and height: control points of a uniform
 * cubic B-spline fitted to the still's frame opening, least squares with a
 * bending penalty. A spline through the traced points themselves carries
 * every wobble of the trace, and reflections show each one as a crease;
 * this one stays within 0.02 of the trace and its curvature never jumps.
 * The ends tuck into the cap and the base.
 */
const glassOutline: ReadonlyArray<readonly [number, number]> = [
	[0.764, -1.145],
	[0.764, -0.86],
	[0.86, -0.621],
	[1.033, -0.408],
	[1.056, -0.112],
	[1.051, 0.177],
	[0.946, 0.435],
	[0.743, 0.629],
	[0.524, 0.791],
	[0.398, 1.044],
]

/** Points along the glass outline, base to cap. */
function glassProfile(samples: number) {
	const spans = glassOutline.length - 3
	return Array.from({ length: samples + 1 }, (_, index) => {
		const at = (index / samples) * spans
		const span = Math.min(Math.floor(at), spans - 1)
		const u = at - span
		const weights = [
			(1 - u) ** 3,
			3 * u ** 3 - 6 * u ** 2 + 4,
			-3 * u ** 3 + 3 * u ** 2 + 3 * u + 1,
			u ** 3,
		]
		const point = new Vector2()
		for (const [k, weight] of weights.entries()) {
			const [radius, y] = glassOutline[span + k]!
			point.x += (weight * radius) / 6
			point.y += (weight * y) / 6
		}
		return point
	})
}

const glassPoints = glassProfile(240)

/** Built a part per `step`. */
export async function createLanternModel(options: {
	step: LanternStep
}): Promise<LanternModel> {
	const { step } = options
	const disposables: Array<{ dispose: () => void }> = []
	const keep = <T extends { dispose: () => void }>(item: T) => {
		disposables.push(item)
		return item
	}

	const root = new Group()
	root.rotation.x = lanternViewPitch
	const lantern = new Group()
	lantern.rotation.order = 'XYZ'
	root.add(lantern)

	const glowTexture = keep(createGlowTexture())
	const metal = keep(createMetalMaterial())
	const litEdge = keep(createLitEdgeMaterial())

	const { glassInterior, glassFloor, handle } = await step(() =>
		buildLantern({ lantern, metal, litEdge, keep }),
	)

	const fluid = new Group()
	const sparkleMaterial = keep(createSparkleMaterial())
	const sparkles = new Points(keep(sparkleGeometry()), sparkleMaterial)
	sparkles.renderOrder = 1
	sparkles.frustumCulled = false
	fluid.add(sparkles)
	root.add(fluid)

	const orbSphere = keep(new SphereGeometry(1, 64, 48))
	const orbs: Array<LanternOrbView> = []
	for (const [index, id] of landingPrimitiveIds.entries()) {
		const orb = await step(() =>
			buildOrb({ id, index, sphere: orbSphere, glowTexture, keep }),
		)
		root.add(orb.group)
		orbs.push(orb)
	}

	const firefliesMaterial = keep(createFireflyMaterial())
	const fireflies = new Points(keep(fireflyGeometry()), firefliesMaterial)
	fireflies.renderOrder = 1
	fireflies.frustumCulled = false
	root.add(fireflies)

	const burst = createBurst(keep(createBurstMaterial()), keep)
	burst.points.renderOrder = 2
	root.add(burst.points)

	const thread = createConstellationThread(
		keep(createThreadMaterial()),
		landingPrimitiveIds.length - 1,
	)
	keep(thread.points.geometry)
	thread.points.renderOrder = 1
	root.add(thread.points)

	const aura = keep(
		createGlowMaterial(glowTexture, {
			color: lanternAmber.glow.clone(),
			opacity: 0.4,
		}),
	)
	const auraSprite = new Sprite(aura)
	auraSprite.scale.set(4.3, 4.8, 1)
	auraSprite.position.set(0, 0.05, -1.4)
	auraSprite.renderOrder = -2
	root.add(auraSprite)

	const plane = keep(new PlaneGeometry(1, 1))
	const pool = keep(createPoolMaterial(glowTexture))
	const poolMesh = new Mesh(plane, pool)
	poolMesh.rotation.x = -Math.PI / 2
	poolMesh.position.y = lanternShape.baseBottom - 0.004
	// The canvas reaches 1.85 units either side of the glass; wider and the
	// pool's faint edge is cut off there.
	poolMesh.scale.set(3.5, 3, 1)
	poolMesh.renderOrder = -2
	const shadow = keep(createShadowMaterial(glowTexture))
	const shadowMesh = new Mesh(plane, shadow)
	shadowMesh.rotation.x = -Math.PI / 2
	shadowMesh.position.y = lanternShape.baseBottom - 0.002
	shadowMesh.scale.set(2.5, 2.1, 1)
	shadowMesh.renderOrder = -2
	const ground = new Group()
	ground.rotation.x = lanternViewPitch
	ground.add(poolMesh, shadowMesh)

	const innerLight = new PointLight(new Color(1, 0.68, 0.3), 7, 0, 2)
	root.add(innerLight)
	for (const { at, color, intensity } of Object.values(lanternLights)) {
		const light = new DirectionalLight(new Color(...color), intensity)
		light.position.set(...at)
		root.add(light)
	}

	return {
		root,
		ground,
		lantern,
		handle,
		fluid,
		orbs,
		glassInterior,
		glassFloor,
		sparkles: sparkleMaterial,
		fireflies: firefliesMaterial,
		burst,
		thread,
		aura,
		pool,
		shadow,
		innerLight,
		dispose() {
			for (const item of disposables) item.dispose()
		},
	}
}

type Keep = <T extends { dispose: () => void }>(item: T) => T

/** Glass, cap, handle, and base. */
function buildLantern(parts: {
	lantern: Group
	metal: MeshStandardMaterial
	litEdge: MeshBasicMaterial
	keep: Keep
}) {
	const { lantern, metal, litEdge, keep } = parts
	const glassGeometry = keep(new LatheGeometry(glassPoints, 192))
	const glassInterior = keep(
		createGlassInteriorMaterial({
			top: lanternShape.capBottom,
			bottom: lanternShape.baseTop,
		}),
	)
	const interior = new Mesh(glassGeometry, glassInterior)
	interior.renderOrder = -1
	const rim = new Mesh(
		glassGeometry,
		keep(createGlassRimMaterial({ top: lanternShape.capBottom })),
	)
	rim.renderOrder = 3
	const reflection = new Mesh(
		glassGeometry,
		keep(createGlassReflectionMaterial()),
	)
	reflection.renderOrder = 4
	lantern.add(interior, rim, reflection)

	lantern.add(new Mesh(keep(capGeometry()), metal))
	const capSeam = new Mesh(
		keep(new TorusGeometry(0.585, 0.014, 16, 192)),
		litEdge,
	)
	capSeam.rotation.x = Math.PI / 2
	capSeam.position.y = lanternShape.capBottom
	const baseSeam = new Mesh(
		keep(new TorusGeometry(0.8, 0.018, 16, 224)),
		litEdge,
	)
	baseSeam.rotation.x = Math.PI / 2
	baseSeam.position.y = lanternShape.baseTop + 0.004
	lantern.add(capSeam, baseSeam)

	const handle = new Group()
	handle.position.y = hingeY
	handle.add(new Mesh(keep(handleGeometry()), metal))
	lantern.add(handle)

	lantern.add(new Mesh(keep(baseGeometry()), metal))
	const glassFloor = keep(createGlassFloorMaterial(floorRadius))
	const floor = new Mesh(keep(new CircleGeometry(floorRadius, 192)), glassFloor)
	floor.rotation.x = -Math.PI / 2
	floor.position.y = lanternShape.baseTop + 0.002
	lantern.add(floor)

	return { glassInterior, glassFloor, handle }
}

/** One orb: a glowing core, a glass shell, its glyph, and a halo. */
function buildOrb(parts: {
	id: LandingPrimitiveId
	index: number
	sphere: SphereGeometry
	glowTexture: ReturnType<typeof createGlowTexture>
	keep: Keep
}): LanternOrbView {
	const { id, index, sphere, glowTexture, keep } = parts
	const group = new Group()
	const roll = new Group()
	const core = keep(createOrbCoreMaterial(index * 3.7 + 1.3))
	const coreMesh = new Mesh(sphere, core)
	coreMesh.scale.setScalar(lanternOrbRadius)
	const shellMaterial = keep(createOrbShellMaterial())
	const shellMesh = new Mesh(sphere, shellMaterial)
	shellMesh.scale.setScalar(lanternOrbRadius * 1.004)
	shellMesh.renderOrder = 0
	roll.add(coreMesh, shellMesh)

	const glyph = new Group()
	const shapes = createGlyphGeometry(id)
	const glyphMaterial = keep(createGlyphMaterial())
	const keyline = keep(createKeylineMaterial())
	for (const mesh of [
		new Mesh(keep(shapes.face), glyphMaterial),
		new Mesh(keep(shapes.keyline), keyline),
	]) {
		mesh.scale.setScalar(lanternOrbRadius * 1.16)
		glyph.add(mesh)
	}

	const halo = keep(
		createGlowMaterial(glowTexture, {
			color: new Color(1, 1, 1),
			opacity: 0.5,
		}),
	)
	const haloSprite = new Sprite(halo)
	haloSprite.scale.setScalar(lanternOrbRadius * 4.4)
	haloSprite.position.z = -lanternOrbRadius * 0.8
	haloSprite.renderOrder = 0

	group.add(haloSprite, roll, glyph)
	return {
		id,
		group,
		roll,
		glyph,
		core,
		shell: shellMaterial,
		glyphMaterial,
		keyline,
		halo,
	}
}

/** Set an orb's colors from its primitive color, linear sRGB. */
export function paintLanternOrb(orb: LanternOrbView, color: Color) {
	orb.core.uniforms.uColor!.value.copy(color)
	const pale = color.clone().lerp(new Color(1, 0.98, 0.94), 0.7)
	orb.glyphMaterial.color.copy(pale)
	orb.glyphMaterial.emissive.copy(pale)
	orb.keyline.color.copy(color).multiplyScalar(0.35)
	orb.halo.color.copy(color)
}

function handleLegX() {
	return lanternShape.handleReach - lanternShape.handleBand / 2
}

/** Segments round every turned part: enough that no highlight steps. */
const turnSegments = 192

/**
 * A turned profile, radius and height, through `corners`, each corner
 * rounded off with an arc of its fillet radius. A rounded edge catches a
 * highlight that rolls round it; a sharp one shows a facet that flashes.
 * The profile runs bottom, side, then top, so its normals face out.
 */
function filleted(
	corners: ReadonlyArray<readonly [radius: number, y: number, fillet?: number]>,
) {
	const points: Array<Vector2> = []
	for (const [index, [x, y, fillet = 0]] of corners.entries()) {
		const previous = corners[index - 1]
		const next = corners[index + 1]
		const corner = new Vector2(x, y)
		if (!previous || !next || fillet === 0) {
			points.push(corner)
			continue
		}
		const back = new Vector2(previous[0], previous[1]).sub(corner).normalize()
		const ahead = new Vector2(next[0], next[1]).sub(corner).normalize()
		const half = Math.acos(Math.min(Math.max(back.dot(ahead), -1), 1)) / 2
		const centre = corner
			.clone()
			.addScaledVector(
				back.clone().add(ahead).normalize(),
				fillet / Math.sin(half),
			)
		const enter = corner.clone().addScaledVector(back, fillet / Math.tan(half))
		const leave = corner.clone().addScaledVector(ahead, fillet / Math.tan(half))
		const from = Math.atan2(enter.y - centre.y, enter.x - centre.x)
		let sweep = Math.atan2(leave.y - centre.y, leave.x - centre.x) - from
		if (sweep > Math.PI) sweep -= Math.PI * 2
		if (sweep < -Math.PI) sweep += Math.PI * 2
		const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 32)))
		for (let step = 0; step <= steps; step++) {
			const angle = from + (sweep * step) / steps
			points.push(
				new Vector2(
					centre.x + Math.cos(angle) * fillet,
					centre.y + Math.sin(angle) * fillet,
				),
			)
		}
	}
	return points
}

/** Cap ring, narrowing a little toward the top as in the still, and the
 *  lid on it with a raised plate on top. */
function capGeometry() {
	const { capBottom, capTop, lidTop, capRadius, lidRadius } = lanternShape
	const plate = lidRadius * 0.74
	return new LatheGeometry(
		filleted([
			[0, capBottom],
			[capRadius, capBottom, 0.026],
			[capRadius - 0.014, capTop, 0.036],
			[lidRadius, capTop, 0.008],
			[lidRadius, lidTop, 0.026],
			[plate, lidTop, 0.004],
			[plate, lidTop + 0.014, 0.007],
			[0, lidTop + 0.018],
		]),
		turnSegments,
	)
}

/** A puck: rounded top edge, a side that flares a touch on the way down,
 *  then a waist where it turns in to a narrower foot, as in the still.
 *  Inside the glass it stops at the lit floor. */
function baseGeometry() {
	const { baseTop, baseBottom, baseRadius, baseWaist, baseFoot } = lanternShape
	return new LatheGeometry(
		filleted([
			[0, baseBottom],
			[baseFoot, baseBottom, 0.06],
			[baseRadius - 0.005, baseWaist, 0.06],
			[baseRadius - 0.029, baseTop, 0.05],
			[0.86, baseTop + 0.006, 0.006],
			[floorRadius - 0.01, baseTop + 0.002],
		]),
		turnSegments,
	)
}

/** Legs up from the hinges, then a rounded arch, relative to the hinge. */
function handleGeometry() {
	const legX = handleLegX()
	const crown = lanternShape.handleTop - lanternShape.handleBand / 2 - hingeY
	const shoulder = crown - 0.34
	// The legs start just inside the cap ring so their open ends never show.
	const points: Array<Vector3> = [
		new Vector3(-legX, -0.04, 0),
		new Vector3(-legX, shoulder * 0.5, 0),
	]
	const steps = 28
	for (let i = 0; i <= steps; i++) {
		const angle = Math.PI - (i / steps) * Math.PI
		points.push(
			new Vector3(
				Math.cos(angle) * legX,
				shoulder + Math.sin(angle) * (crown - shoulder),
				0,
			),
		)
	}
	points.push(new Vector3(legX, shoulder * 0.5, 0), new Vector3(legX, -0.04, 0))
	const tube = new TubeGeometry(
		new CatmullRomCurve3(points, false, 'centripetal'),
		256,
		lanternShape.handleBand / 2,
		32,
		false,
	)
	// A band rather than a rod, like the still's handle.
	tube.scale(1, 1, 1.35)
	return tube
}

/** Deterministic, so the sparkle field is the same on every visit. */
function seeded(seed: number) {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** Radius of the glass at height `y`. */
function glassRadiusAt(y: number) {
	for (let i = 1; i < glassPoints.length; i++) {
		const upper = glassPoints[i]!
		if (y > upper.y) continue
		const lower = glassPoints[i - 1]!
		const share = (y - lower.y) / (upper.y - lower.y)
		return lower.x + (upper.x - lower.x) * Math.min(Math.max(share, 0), 1)
	}
	return glassPoints[glassPoints.length - 1]!.x
}

function sparkleGeometry() {
	const random = seeded(2414)
	const count = 460
	const positions = new Float32Array(count * 3)
	const sizes = new Float32Array(count)
	const seeds = new Float32Array(count)
	const top = lanternCavity.top - 0.05
	const bottom = lanternCavity.bottom + 0.04
	for (let i = 0; i < count; i++) {
		const y = bottom + random() * (top - bottom)
		const reach = Math.sqrt(random()) * (glassRadiusAt(y) - 0.06)
		const angle = random() * Math.PI * 2
		const x = Math.cos(angle) * reach
		const z = Math.sin(angle) * reach
		positions.set([x, y, z], i * 3)
		const pick = random()
		sizes[i] =
			pick > 0.965
				? 0.09 + random() * 0.05
				: pick > 0.8
					? 0.04 + random() * 0.03
					: 0.014 + random() * 0.02
		seeds[i] = random()
	}
	const geometry = new BufferGeometry()
	geometry.setAttribute('position', new BufferAttribute(positions, 3))
	geometry.setAttribute('aSize', new BufferAttribute(sizes, 1))
	geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1))
	return geometry
}

/** Position carries each firefly's orbit radius, height, and speed. */
function fireflyGeometry() {
	const random = seeded(2402)
	const count = 18
	const positions = new Float32Array(count * 3)
	const sizes = new Float32Array(count)
	const seeds = new Float32Array(count)
	for (let i = 0; i < count; i++) {
		const direction = random() > 0.5 ? 1 : -1
		positions.set(
			[
				1.2 + random() * 0.45,
				-0.9 + random() * 2.5,
				direction * (0.1 + random() * 0.16),
			],
			i * 3,
		)
		sizes[i] = 0.035 + random() * 0.03
		seeds[i] = random()
	}
	const geometry = new BufferGeometry()
	geometry.setAttribute('position', new BufferAttribute(positions, 3))
	geometry.setAttribute('aSize', new BufferAttribute(sizes, 1))
	geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1))
	return geometry
}

function createBurst(
	material: ShaderMaterial,
	keep: <T extends { dispose: () => void }>(item: T) => T,
): LanternBurst {
	const count = 192
	const origins = new BufferAttribute(new Float32Array(count * 3), 3)
	const velocities = new BufferAttribute(new Float32Array(count * 3), 3)
	const colors = new BufferAttribute(new Float32Array(count * 3), 3)
	const births = new BufferAttribute(new Float32Array(count).fill(-100), 1)
	const geometry = keep(new BufferGeometry())
	geometry.setAttribute('position', origins)
	geometry.setAttribute('aVelocity', velocities)
	geometry.setAttribute('aColor', colors)
	geometry.setAttribute('aBirth', births)
	const points = new Points(geometry, material)
	points.frustumCulled = false
	const random = seeded(2426)
	let next = 0
	return {
		points,
		emit(origin, color, { count: sparks, speed, time }) {
			for (let i = 0; i < sparks; i++) {
				const index = next
				next = (next + 1) % count
				const theta = random() * Math.PI * 2
				const phi = Math.acos(random() * 2 - 1)
				const pace = speed * (0.45 + random() * 0.75)
				const direction = new Vector3(
					Math.sin(phi) * Math.cos(theta),
					Math.sin(phi) * Math.sin(theta),
					Math.cos(phi),
				)
				const start = origin
					.clone()
					.addScaledVector(direction, lanternOrbRadius * 0.9)
				origins.setXYZ(index, start.x, start.y, start.z)
				velocities.setXYZ(
					index,
					direction.x * pace,
					direction.y * pace,
					direction.z * pace,
				)
				const tint = color.clone().lerp(new Color(1, 1, 1), random() * 0.5)
				colors.setXYZ(index, tint.r, tint.g, tint.b)
				births.setX(index, time + random() * 0.06)
			}
			origins.needsUpdate = true
			velocities.needsUpdate = true
			colors.needsUpdate = true
			births.needsUpdate = true
		},
	}
}
