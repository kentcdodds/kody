import {
	BufferAttribute,
	BufferGeometry,
	CapsuleGeometry,
	CatmullRomCurve3,
	CircleGeometry,
	Color,
	CylinderGeometry,
	DirectionalLight,
	Group,
	HemisphereLight,
	LatheGeometry,
	Mesh,
	type MeshBasicMaterial,
	type MeshStandardMaterial,
	PlaneGeometry,
	PointLight,
	Points,
	type ShaderMaterial,
	SphereGeometry,
	SplineCurve,
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
	createGlassRimMaterial,
	createGlassShellMaterial,
	createGlowMaterial,
	createGlowTexture,
	createGlyphMaterial,
	createLitEdgeMaterial,
	createMetalMaterial,
	createOrbCoreMaterial,
	createOrbShellMaterial,
	createPoolMaterial,
	createShadowMaterial,
	createSparkleMaterial,
	lanternAmber,
} from './lantern-3d-materials.ts'

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
	shell: ShaderMaterial
	glyphMaterial: MeshStandardMaterial
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
	aura: SpriteMaterial
	pool: MeshBasicMaterial
	shadow: MeshBasicMaterial
	innerLight: PointLight
	dispose: () => void
}

/** Runs one slice of startup, then yields. Rejects once startup is dropped. */
export type LanternStep = <T>(work: () => T | PromiseLike<T>) => Promise<T>

/** Above the still's horizon, as its cap and base rims show. */
export const lanternViewPitch = 0.1

/** Hinge height of the handle, on top of the cap ring. */
const hingeY = lanternShape.capTop + 0.02

/** The base's top inside the glass, tucked under the metal lip. */
const floorRadius = 0.83

/** Profile of the glass as radius and height, traced from the still's
 *  frame opening. The ends tuck into the cap and the base. */
const glassProfile: ReadonlyArray<readonly [number, number]> = [
	[0.78, lanternShape.baseTop - 0.07],
	[0.8, lanternShape.baseTop],
	[0.806, -0.757],
	[0.818, -0.69],
	[0.872, -0.629],
	[0.932, -0.551],
	[0.986, -0.45],
	[1.026, -0.33],
	[1.045, -0.2],
	[1.048, 0],
	[1.042, 0.16],
	[0.998, 0.294],
	[0.958, 0.369],
	[0.866, 0.507],
	[0.776, 0.601],
	[0.733, 0.638],
	[0.652, 0.69],
	[0.596, 0.726],
	[0.562, lanternShape.capBottom],
	[0.54, lanternShape.capBottom + 0.04],
]

/** `lite` trades the clear coats and some curve detail for frame time on
 *  software renderers. Built a part per `step`. */
export async function createLanternModel(options: {
	lite: boolean
	step: LanternStep
}): Promise<LanternModel> {
	const { lite, step } = options
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
	const metal = keep(createMetalMaterial(lite))
	const litEdge = keep(createLitEdgeMaterial())

	const { glassInterior, glassFloor, handle } = await step(() =>
		buildLantern({ lantern, lite, metal, litEdge, keep }),
	)

	const fluid = new Group()
	const sparkleMaterial = keep(createSparkleMaterial())
	const sparkles = new Points(keep(sparkleGeometry()), sparkleMaterial)
	sparkles.renderOrder = 1
	sparkles.frustumCulled = false
	fluid.add(sparkles)
	root.add(fluid)

	const orbSphere = keep(
		lite ? new SphereGeometry(1, 24, 16) : new SphereGeometry(1, 40, 28),
	)
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
	poolMesh.scale.set(4.6, 3.4, 1)
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

	const innerLight = new PointLight(new Color(1, 0.6, 0.2), 7, 0, 2)
	root.add(innerLight)
	const key = new DirectionalLight(new Color(1, 0.95, 0.88), 1.9)
	key.position.set(-2.6, 4.2, 5)
	const back = new DirectionalLight(new Color(1, 0.82, 0.58), 1.1)
	back.position.set(3.2, 1.6, -3.4)
	root.add(key, back, new HemisphereLight(0xfff4e6, 0x2a1608, 0.55))

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
	lite: boolean
	metal: ReturnType<typeof createMetalMaterial>
	litEdge: MeshBasicMaterial
	keep: Keep
}) {
	const { lantern, lite, metal, litEdge, keep } = parts
	const glassGeometry = keep(
		new LatheGeometry(
			new SplineCurve(
				glassProfile.map(([radius, y]) => new Vector2(radius, y)),
			).getPoints(64),
			96,
		),
	)
	const glassInterior = keep(
		createGlassInteriorMaterial({
			top: lanternShape.capBottom,
			bottom: lanternShape.baseTop,
		}),
	)
	const interior = new Mesh(glassGeometry, glassInterior)
	interior.renderOrder = -1
	const shell = new Mesh(glassGeometry, keep(createGlassShellMaterial(lite)))
	shell.renderOrder = 3
	const rim = new Mesh(glassGeometry, keep(createGlassRimMaterial()))
	rim.renderOrder = 4
	lantern.add(interior, shell, rim)

	lantern.add(new Mesh(keep(capGeometry()), metal))
	const capSeam = new Mesh(
		keep(new TorusGeometry(0.585, 0.014, 6, 96)),
		litEdge,
	)
	capSeam.rotation.x = Math.PI / 2
	capSeam.position.y = lanternShape.capBottom
	const baseSeam = new Mesh(
		keep(new TorusGeometry(0.8, 0.018, 6, 112)),
		litEdge,
	)
	baseSeam.rotation.x = Math.PI / 2
	baseSeam.position.y = lanternShape.baseTop + 0.004
	lantern.add(capSeam, baseSeam)

	const vent = keep(new CapsuleGeometry(0.011, 0.05, 4, 8))
	const ventCount = 10
	for (let i = 0; i < ventCount; i++) {
		const angle = (i / ventCount) * Math.PI * 2
		const mesh = new Mesh(vent, litEdge)
		mesh.position.set(
			Math.sin(angle) * (lanternShape.lidRadius - 0.004),
			lanternShape.capTop + 0.058,
			Math.cos(angle) * (lanternShape.lidRadius - 0.004),
		)
		mesh.rotation.set(0, angle, Math.PI / 2)
		lantern.add(mesh)
	}

	const pin = keep(new CylinderGeometry(0.05, 0.05, 0.1, 16))
	for (const side of [-1, 1]) {
		const mesh = new Mesh(pin, metal)
		mesh.rotation.z = Math.PI / 2
		mesh.position.set(side * handleLegX(), hingeY + 0.012, 0)
		lantern.add(mesh)
	}

	const handle = new Group()
	handle.position.y = hingeY
	handle.add(new Mesh(keep(handleGeometry()), metal))
	lantern.add(handle)

	lantern.add(new Mesh(keep(baseGeometry()), metal))
	const glassFloor = keep(createGlassFloorMaterial(floorRadius))
	const floor = new Mesh(keep(new CircleGeometry(floorRadius, 96)), glassFloor)
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
	const glyphMaterial = keep(createGlyphMaterial())
	const glyphMesh = new Mesh(keep(createGlyphGeometry(id)), glyphMaterial)
	glyphMesh.scale.setScalar(lanternOrbRadius * 1.08)
	glyph.add(glyphMesh)

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
		halo,
	}
}

/** Set an orb's colors from its primitive color, linear sRGB. */
export function paintLanternOrb(orb: LanternOrbView, color: Color) {
	orb.core.uniforms.uColor!.value.copy(color)
	orb.shell.uniforms.uRim!.value.copy(color).lerp(new Color(1, 1, 1), 0.45)
	orb.glyphMaterial.emissive.copy(color).lerp(new Color(1, 0.97, 0.9), 0.84)
	orb.halo.color.copy(color)
}

function handleLegX() {
	return lanternShape.handleReach - lanternShape.handleBand / 2
}

/** Cap ring and the lid on top of it, with a shallow dome. */
function capGeometry() {
	const bottom = lanternShape.capBottom
	const top = lanternShape.capTop
	const lid = lanternShape.lidTop
	const r = lanternShape.capRadius
	const lr = lanternShape.lidRadius
	const profile: Array<readonly [number, number]> = [
		[0, bottom],
		[r - 0.05, bottom],
		[r - 0.018, bottom + 0.006],
		[r - 0.004, bottom + 0.024],
		[r, bottom + 0.055],
		[r, top - 0.05],
		[r - 0.006, top - 0.022],
		[r - 0.024, top - 0.006],
		[r - 0.055, top],
		[lr + 0.02, top],
		[lr + 0.004, top + 0.008],
		[lr, top + 0.026],
		[lr, lid - 0.022],
		[lr - 0.008, lid - 0.007],
		[lr - 0.03, lid],
		[lr * 0.72, lid],
		[lr * 0.68, lid + 0.006],
		[lr * 0.4, lid + 0.014],
		[0, lid + 0.017],
	]
	return new LatheGeometry(
		profile.map(([x, y]) => new Vector2(x, y)),
		96,
	)
}

/** A puck: rounded top edge, the side tapering in to the foot. Inside the
 *  glass it stops at the lit floor. */
function baseGeometry() {
	const top = lanternShape.baseTop
	const bottom = lanternShape.baseBottom
	const r = lanternShape.baseRadius
	const foot = lanternShape.baseFoot
	const profile: Array<readonly [number, number]> = [
		[0, bottom],
		[foot - 0.09, bottom],
		[foot - 0.035, bottom + 0.008],
		[foot - 0.006, bottom + 0.03],
		[foot + 0.01, bottom + 0.07],
		[foot + 0.035, bottom + 0.2],
		[r - 0.02, top - 0.17],
		[r - 0.002, top - 0.075],
		[r, top - 0.045],
		[r - 0.012, top - 0.016],
		[r - 0.04, top - 0.002],
		[r - 0.09, top + 0.004],
		[0.86, top + 0.006],
		[floorRadius - 0.01, top + 0.002],
	]
	return new LatheGeometry(
		profile.map(([x, y]) => new Vector2(x, y)),
		96,
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
		112,
		lanternShape.handleBand / 2,
		14,
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

/** Radius of the glass at height `y`, from the traced profile. */
function glassRadiusAt(y: number) {
	for (let i = 1; i < glassProfile.length; i++) {
		const [r1, y1] = glassProfile[i]!
		if (y > y1) continue
		const [r0, y0] = glassProfile[i - 1]!
		const share = (y - y0) / (y1 - y0)
		return r0 + (r1 - r0) * Math.min(Math.max(share, 0), 1)
	}
	return glassProfile[glassProfile.length - 1]![0]
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
