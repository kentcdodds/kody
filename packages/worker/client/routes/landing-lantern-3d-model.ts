import {
	AdditiveBlending,
	BackSide,
	BufferAttribute,
	CircleGeometry,
	Color,
	CustomBlending,
	Curve,
	DataTexture,
	DirectionalLight,
	DoubleSide,
	Group,
	InstancedBufferAttribute,
	InstancedBufferGeometry,
	LatheGeometry,
	LinearFilter,
	LinearMipmapLinearFilter,
	Mesh,
	MeshBasicMaterial,
	MeshPhysicalMaterial,
	OneFactor,
	OneMinusSrcAlphaFactor,
	PlaneGeometry,
	PointLight,
	RepeatWrapping,
	Scene,
	ShaderMaterial,
	SphereGeometry,
	TubeGeometry,
	Vector2,
	Vector3,
	type Material,
	type Texture,
	type WebGLProgramParametersWithUniforms,
} from 'three'
import {
	lanternGlass,
	lanternOrbRadius,
} from '#client/routes/landing-lantern-3d-motion.ts'
import {
	landingPrimitiveIds,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/**
 * The 3D lantern's model, after the lantern art: charcoal hardware (a
 * handle, a two-tier cap, a drum base) round an amber glass jar that
 * glows white hot under the cap and on its floor, full of stars, with the
 * six primitive marbles. landing-lantern-3d-scene.ts lights it, renders
 * it, and blooms it.
 *
 * Units and axes are the motion module's: the pivot is the glass's centre,
 * y is up, and the camera looks from +z. `lantern` holds everything that
 * turns with the lantern; the marbles are placed in world space each
 * frame, and always face the camera so their glyphs read from any side.
 *
 * Glow is written as one amber hue at an intensity (`amber * k`, linear
 * light): the scene's tone curve turns it deep amber at k 0.4, gold at
 * 1.3, and yellow toward white past 2, as the art's glass does.
 */

/** The profile corners as `[r, h, fillet]`, bottom to top, so lathe
 *  normals face out. */
type ProfileCorner = readonly [r: number, h: number, fillet?: number]

/** The cap: a wide lower tier that closes the glass and takes the
 *  handle's legs, a narrower upper tier, and a plate on top. */
const capProfile: ReadonlyArray<ProfileCorner> = [
	[0, lanternGlass.top],
	[0.627, lanternGlass.top, 0.045],
	[0.627, 0.965, 0.035],
	[0.445, 0.965, 0.012],
	[0.445, 1.057, 0.03],
	[0.3, 1.057, 0.008],
	[0.29, 1.08, 0.012],
	[0, 1.082],
]

/** The base: a short foot, a chamfer out to a rounded drum, and a lip
 *  the glass sits in. */
const baseProfile: ReadonlyArray<ProfileCorner> = [
	[0, -1.09],
	[0.64, -1.09, 0.015],
	[0.66, -1.04, 0.02],
	[0.92, -0.95, 0.06],
	[0.905, -0.69, 0.045],
	[0.76, -0.672, 0.01],
	[0, -0.672],
]

/** The handle's centre line: a squarish arch whose legs dip into the
 *  cap's lower tier. */
const handle = {
	centre: 1.076,
	halfWidth: 0.588,
	rise: 0.482,
	/** Superellipse exponent: 2 is an ellipse, higher is squarer. */
	squareness: 2.3,
	/** How far past level the legs run, radians. */
	overrun: 0.42,
	radius: 0.082,
} as const

/** The marbles' colors (light, mid, deep), from the orb art. */
const orbPalette: Record<
	LandingPrimitiveId,
	readonly [string, string, string]
> = {
	memory: ['#ff9478', '#f2412e', '#b31c16'],
	// Bluer than the secrets tone: the amber glow behind it warms its
	// face, and a true purple turns pink there, next to apps.
	secrets: ['#9a7dff', '#5a3cf0', '#2a1494'],
	packages: ['#9ccdff', '#2483f2', '#0b4fb8'],
	triggers: ['#fff8c4', '#ffdb2e', '#ffb800'],
	integrations: ['#9ff5b6', '#1bba56', '#077a33'],
	apps: ['#ffb8ea', '#f450c0', '#b31e7c'],
}

/** Share of a glyph texture the marble's visible disc spans, per side. */
const glyphSpan = 0.53

/** The jar's stars, by size: specks, stars, and a few bright ones with
 *  rays. Sizes are world units: the sprite's half width, the white core's
 *  radius, and the gold halo's falloff; `peak` is the core's intensity. */
const starTiers = [
	{
		count: 100,
		size: 0.05,
		core: [0.0035, 0.006],
		halo: [0.008, 0.013],
		peak: [1.2, 2.4],
		rays: false,
	},
	{
		count: 40,
		size: 0.12,
		core: [0.007, 0.01],
		halo: [0.018, 0.026],
		peak: [2.6, 4.4],
		rays: false,
	},
	{
		count: 14,
		size: 0.26,
		core: [0.012, 0.017],
		halo: [0.032, 0.045],
		peak: [4.5, 7],
		rays: true,
	},
] as const

const glslAmber = 'vec3(1.0, 0.33, 0.016)'

type LanternUniforms = {
	time: { value: number }
	/** The glass's light, 1 at rest: the flare of a tap lifts it. */
	light: { value: number }
	/** The stars' brightness, 1 at rest. */
	sparkle: { value: number }
}

type LanternOrb = {
	mesh: Mesh
	glow: { value: number }
}

export type LanternModel = {
	/** Everything that turns with the lantern. */
	lantern: Group
	/** Lights that stay put while the lantern turns. */
	lights: Group
	orbs: Record<LandingPrimitiveId, LanternOrb>
	uniforms: LanternUniforms
	dispose(): void
}

export function createLanternModel(options: {
	glyphs: Record<LandingPrimitiveId, Texture>
}): LanternModel {
	const disposables: Array<{ dispose(): void }> = []
	const keep = <T extends { dispose(): void }>(item: T) => {
		disposables.push(item)
		return item
	}
	const uniforms: LanternUniforms = {
		time: { value: 0 },
		light: { value: 1 },
		sparkle: { value: 1 },
	}
	const grain = keep(createGrainTexture())
	const hardware = keep(createHardwareMaterial(grain, uniforms))
	const lantern = new Group()

	const cap = new Mesh(
		keep(new LatheGeometry(roundedProfile(capProfile), 160)),
		hardware,
	)
	const base = new Mesh(
		keep(new LatheGeometry(roundedProfile(baseProfile), 160)),
		hardware,
	)
	const arch = new Mesh(
		keep(new TubeGeometry(new HandleCurve(), 240, handle.radius, 40)),
		hardware,
	)

	const sphere = keep(new SphereGeometry(1, 128, 96))
	const backWall = new Mesh(
		sphere,
		keep(createBackWallMaterial(uniforms, grain)),
	)
	backWall.scale.set(
		lanternGlass.radius * lanternGlass.inner,
		lanternGlass.height * lanternGlass.inner,
		lanternGlass.radius * lanternGlass.inner,
	)
	const floorRadius = glassRadiusAt(lanternGlass.floor) * lanternGlass.inner
	const floor = new Mesh(
		keep(new CircleGeometry(floorRadius, 128)),
		keep(createFloorMaterial(uniforms, floorRadius)),
	)
	floor.rotation.x = -Math.PI / 2
	floor.position.y = lanternGlass.floor
	const collar = new Mesh(
		keep(new LatheGeometry(glassBandProfile(0.6, lanternGlass.top), 160)),
		keep(createCollarMaterial(uniforms)),
	)
	collar.renderOrder = 1
	const stars = new Mesh(
		keep(createStarGeometry()),
		keep(createStarMaterial(uniforms)),
	)
	stars.frustumCulled = false
	stars.renderOrder = 2
	const glass = new Mesh(sphere, keep(createGlassMaterial(uniforms)))
	glass.scale.set(lanternGlass.radius, lanternGlass.height, lanternGlass.radius)
	glass.renderOrder = 3
	lantern.add(cap, base, arch, backWall, floor, collar, stars, glass)

	const orbGeometry = keep(new SphereGeometry(lanternOrbRadius, 72, 54))
	const orbs = Object.fromEntries(
		landingPrimitiveIds.map((id): [LandingPrimitiveId, LanternOrb] => {
			const glow = { value: 1 }
			const material = keep(
				createOrbMaterial(orbPalette[id], options.glyphs[id], glow),
			)
			return [id, { mesh: new Mesh(orbGeometry, material), glow }]
		}),
	) as Record<LandingPrimitiveId, LanternOrb>

	return {
		lantern,
		lights: createLights(),
		orbs,
		uniforms,
		dispose() {
			for (const item of disposables) item.dispose()
		},
	}
}

/** A key from above right, as in the art, a cool light from the left
 *  that keeps the hardware's left edges blue, a rim from behind for a dark
 *  page, and the jar's own glow, which warms the marbles. */
function createLights() {
	const lights = new Group()
	const key = new DirectionalLight('#fff4e8', 3.6)
	key.position.set(2.8, 3.6, 2.6)
	const cool = new DirectionalLight('#8fa8ff', 1.4)
	cool.position.set(-3.6, 0.6, 0.4)
	const rim = new DirectionalLight('#ffe7c8', 1.2)
	rim.position.set(-0.9, 2.6, -3.4)
	const ember = new PointLight('#ff9a2e', 2.2, 0, 2)
	lights.add(key, cool, rim, ember)
	return lights
}

/** The studio the hardware and the glass reflect, for an environment map:
 *  a dim room on warm ground and the lights behind the art's reflections,
 *  a tall one to the right (the arc down the glass's right side), a strip
 *  behind on the left (the streak down its left edge), and a small one up
 *  behind on the left (the spot on its shoulder), with a light overhead
 *  and a cool one to the left for the hardware. Nothing bright faces the
 *  jar head on, so its amber stays clear. */
export function createLanternStudio() {
	const scene = new Scene()
	const room = new SphereGeometry(30, 48, 24)
	const shade = new Float32Array(room.attributes.position!.count * 3)
	const top = new Color('#2e2e34')
	const horizon = new Color('#1a1b20')
	const bottom = new Color('#2a1709')
	const color = new Color()
	for (let i = 0; i < room.attributes.position!.count; i++) {
		const y = room.attributes.position!.getY(i) / 30
		if (y > 0) color.lerpColors(horizon, top, Math.pow(y, 0.8))
		else color.lerpColors(horizon, bottom, Math.pow(-y, 0.6))
		color.toArray(shade, i * 3)
	}
	room.setAttribute('color', new BufferAttribute(shade, 3))
	scene.add(
		new Mesh(
			room,
			new MeshBasicMaterial({ side: BackSide, vertexColors: true }),
		),
	)
	const pane = new PlaneGeometry(1, 1)
	const panel = (
		tint: string,
		intensity: number,
		at: readonly [number, number, number],
		size: readonly [number, number],
		roll = 0,
	) => {
		const mesh = new Mesh(
			pane,
			new MeshBasicMaterial({
				color: new Color(tint).multiplyScalar(intensity),
				side: DoubleSide,
			}),
		)
		mesh.position.set(...at)
		mesh.lookAt(0, 0, 0)
		mesh.rotateZ(roll)
		mesh.scale.set(size[0], size[1], 1)
		scene.add(mesh)
	}
	panel('#fff6ec', 16, [8.2, 4, -0.6], [1.6, 8.5], -0.35)
	panel('#fff6ec', 6, [-8.2, 1.6, -3.6], [0.7, 8])
	panel('#fff8f0', 9, [-6.6, 6.8, -2.2], [2.6, 0.8], 0.6)
	panel('#fff8f0', 6, [2.5, 9.5, 2.5], [4, 2])
	panel('#a9bcff', 2.6, [-8, 0.5, 2], [3, 8])
	panel('#ffe9d2', 2, [7.5, 1, -5.5], [2, 8])
	return {
		scene,
		dispose() {
			scene.traverse((node) => {
				if (!(node instanceof Mesh)) return
				node.geometry.dispose()
				const material = node.material as Material
				material.dispose()
			})
		},
	}
}

/** Corners joined by straight runs, each rounded by its fillet. Fillets
 *  are sampled finely, so the lathe's averaged normals stay smooth there
 *  and the runs between them stay flat. */
function roundedProfile(corners: ReadonlyArray<ProfileCorner>): Array<Vector2> {
	const points: Array<Vector2> = []
	corners.forEach(([r, h, fillet = 0], index) => {
		const here = new Vector2(r, h)
		const before = corners[index - 1]
		const after = corners[index + 1]
		if (!before || !after || fillet <= 0) {
			points.push(here)
			return
		}
		const from = new Vector2(before[0], before[1])
		const to = new Vector2(after[0], after[1])
		const into = here.clone().sub(from).normalize()
		const out = to.clone().sub(here).normalize()
		const turn = Math.acos(Math.min(Math.max(into.dot(out), -1), 1))
		if (turn < 1e-3) {
			points.push(here)
			return
		}
		const reach = Math.min(
			fillet * Math.tan(turn / 2),
			here.distanceTo(from) / 2,
			here.distanceTo(to) / 2,
		)
		const start = here.clone().addScaledVector(into, -reach)
		const end = here.clone().addScaledVector(out, reach)
		const steps = Math.max(4, Math.ceil(turn / (Math.PI / 32)))
		for (let step = 0; step <= steps; step++) {
			const t = step / steps
			const u = 1 - t
			points.push(
				new Vector2(
					u * u * start.x + 2 * u * t * here.x + t * t * end.x,
					u * u * start.y + 2 * u * t * here.y + t * t * end.y,
				),
			)
		}
	})
	return points
}

/** The glass's outer radius at height `h`. */
function glassRadiusAt(h: number) {
	const share = Math.min(Math.abs(h) / lanternGlass.height, 1)
	return lanternGlass.radius * Math.sqrt(1 - share * share)
}

/** A strip of the glass's surface, just inside it, from `bottom` to `top`. */
function glassBandProfile(bottom: number, top: number) {
	return Array.from({ length: 33 }, (_, step) => {
		const h = bottom + ((top - bottom) * step) / 32
		return new Vector2(glassRadiusAt(h) * 0.99, h)
	})
}

class HandleCurve extends Curve<Vector3> {
	constructor() {
		super()
		this.arcLengthDivisions = 2000
	}

	override getPoint(t: number, target = new Vector3()) {
		const { centre, halfWidth, rise, squareness, overrun } = handle
		const angle = -overrun + t * (Math.PI + 2 * overrun)
		const power = 2 / squareness
		const along = (value: number) => Math.sign(value) * Math.abs(value) ** power
		return target.set(
			halfWidth * along(Math.cos(angle)),
			centre + rise * along(Math.sin(angle)),
			0,
		)
	}
}

/** Charcoal powder coat over hammered metal. The grain is projected from
 *  the part's own axes (triplanar), so it needs no UVs and turns with the
 *  lantern. Faces toward the jar take its amber, as the handle's inside
 *  and the base's lip do in the art. */
function createHardwareMaterial(grain: Texture, uniforms: LanternUniforms) {
	const material = new MeshPhysicalMaterial({
		color: '#3a3b41',
		metalness: 0,
		roughness: 0.38,
		clearcoat: 0.3,
		clearcoatRoughness: 0.3,
		envMapIntensity: 1,
	})
	material.onBeforeCompile = (shader) => {
		shader.uniforms.grainMap = { value: grain }
		shader.uniforms.light = uniforms.light
		withObjectSpace(shader)
		shader.fragmentShader = shader.fragmentShader
			.replace(
				'#include <common>',
				`#include <common>
				uniform sampler2D grainMap;
				uniform float light;
				uniform mat3 normalMatrix;
				varying vec3 vObjectPosition;
				varying vec3 vObjectNormal;`,
			)
			.replace(
				'#include <normal_fragment_maps>',
				`#include <normal_fragment_maps>
				{
					vec3 weights = pow(abs(vObjectNormal), vec3(4.0));
					weights /= dot(weights, vec3(1.0));
					vec3 p = vObjectPosition * 7.0;
					vec4 gx = texture2D(grainMap, p.zy);
					vec4 gy = texture2D(grainMap, p.xz);
					vec4 gz = texture2D(grainMap, p.xy);
					vec3 bump =
						weights.x * vec3(0.0, gx.y - 0.5, gx.x - 0.5) +
						weights.y * vec3(gy.x - 0.5, 0.0, gy.y - 0.5) +
						weights.z * vec3(gz.x - 0.5, gz.y - 0.5, 0.0);
					normal = normalize(normal + normalMatrix * bump * 0.9);
					float pits = weights.x * gx.w + weights.y * gy.w + weights.z * gz.w;
					roughnessFactor = clamp(roughnessFactor * (0.82 + pits * 0.4), 0.05, 1.0);
				}`,
			)
			.replace(
				'#include <emissivemap_fragment>',
				`#include <emissivemap_fragment>
				{
					vec3 heart = vec3(0.0, 0.15, 0.0);
					vec3 toJar = heart - vObjectPosition;
					float facing = saturate(dot(normalize(vObjectNormal), normalize(toJar)));
					float near = exp(-max(length(toJar) - 0.85, 0.0) * 1.6);
					totalEmissiveRadiance += ${glslAmber} * facing * facing * near * 1.1 * light;
				}`,
			)
	}
	material.customProgramCacheKey = () => 'lantern-hardware'
	return material
}

/** Clear glass: crisp reflections and an amber rim where it turns away,
 *  blended over the jar's contents. It adds its light in full and dims
 *  what is behind it only as much as it is opaque, so a reflection stays
 *  bright where the glass is clear. */
function createGlassMaterial(uniforms: LanternUniforms) {
	const material = new MeshPhysicalMaterial({
		color: '#000000',
		metalness: 0,
		roughness: 0.03,
		ior: 1.5,
		envMapIntensity: 1,
		transparent: true,
		depthWrite: false,
		blending: CustomBlending,
		blendSrc: OneFactor,
		blendDst: OneMinusSrcAlphaFactor,
		blendSrcAlpha: OneFactor,
		blendDstAlpha: OneMinusSrcAlphaFactor,
	})
	material.onBeforeCompile = (shader) => {
		shader.uniforms.light = uniforms.light
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', '#include <common>\nuniform float light;')
			.replace(
				'#include <opaque_fragment>',
				`float facing = saturate(dot(geometryNormal, geometryViewDir));
				float edge = pow(1.0 - facing, 3.0);
				vec3 rim = ${glslAmber} * edge * 2.6 * light;
				// The art's rim is the glass's own gold, not the room seen at
				// a graze, so reflections give way to it at the edge.
				vec3 reflected = outgoingLight * (1.0 - 0.7 * edge);
				gl_FragColor = vec4(reflected + rim, clamp(0.04 + edge * 0.9, 0.0, 1.0));`,
			)
	}
	material.customProgramCacheKey = () => 'lantern-glass'
	return material
}

const glslNoise = /* glsl */ `
	float hash13(vec3 p) {
		p = fract(p * 0.1031);
		p += dot(p, p.zyx + 31.32);
		return fract((p.x + p.y) * p.z);
	}
	float valueNoise(vec3 p) {
		vec3 i = floor(p);
		vec3 f = fract(p);
		f = f * f * (3.0 - 2.0 * f);
		return mix(
			mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x),
				mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
			mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x),
				mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
			f.z);
	}
`

/** The far wall of the jar, seen through the glass: deep amber where it
 *  is seen straight on, gold toward the rim, lit by the collar and the
 *  floor, with a slow haze and a faint web through it. */
function createBackWallMaterial(uniforms: LanternUniforms, grain: Texture) {
	return new ShaderMaterial({
		side: BackSide,
		uniforms: {
			light: uniforms.light,
			time: uniforms.time,
			top: { value: lanternGlass.top },
			bottom: { value: lanternGlass.floor },
			grainMap: { value: grain },
		},
		vertexShader: /* glsl */ `
			varying vec3 vLocal;
			varying float vHeight;
			varying vec3 vViewPosition;
			varying vec3 vViewNormal;
			void main() {
				vLocal = position;
				vHeight = (modelMatrix * vec4(position, 1.0)).y;
				vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
				vViewPosition = viewPosition.xyz;
				vViewNormal = normalMatrix * normal;
				gl_Position = projectionMatrix * viewPosition;
			}
		`,
		fragmentShader: /* glsl */ `
			uniform float light;
			uniform float time;
			uniform float top;
			uniform float bottom;
			uniform sampler2D grainMap;
			varying vec3 vLocal;
			varying float vHeight;
			varying vec3 vViewPosition;
			varying vec3 vViewNormal;
			${glslNoise}
			void main() {
				vec3 toEye = normalize(-vViewPosition);
				// Rounding can carry the dot past 1, and pow() is undefined
				// for a negative base.
				float facing = min(abs(dot(normalize(vViewNormal), toEye)), 1.0);
				float k = 0.34 + 0.85 * pow(1.0 - facing, 0.9);
				k += 0.7 * exp((vHeight - top) / 0.07);
				k += 1.1 * exp((bottom - vHeight) / 0.06);
				float haze = valueNoise(vLocal * 2.6 + vec3(0.0, time * 0.05, 0.0));
				haze += 0.5 * valueNoise(vLocal * 5.3 - vec3(time * 0.03, 0.0, 0.0));
				k *= 0.82 + haze * 0.26;
				vec3 weights = pow(abs(normalize(vLocal)), vec3(4.0));
				weights /= dot(weights, vec3(1.0));
				vec3 p = vLocal * 0.25 + vec3(0.0, time * 0.002, 0.0);
				float web = weights.x * texture2D(grainMap, p.zy).b +
					weights.y * texture2D(grainMap, p.xz).b +
					weights.z * texture2D(grainMap, p.xy).b;
				// Whole, the cell borders read as a honeycomb. Kept only
				// where the haze runs bright, they break into filaments.
				k += web * smoothstep(0.8, 1.1, haze) * 0.3;
				gl_FragColor = vec4(${glslAmber} * k * light, 1.0);
			}
		`,
	})
}

/** The pad the jar stands on: bright yellow, white hot at its edge. */
function createFloorMaterial(uniforms: LanternUniforms, radius: number) {
	return new ShaderMaterial({
		uniforms: { light: uniforms.light, radius: { value: radius } },
		vertexShader: /* glsl */ `
			varying vec2 vLocal;
			void main() {
				vLocal = position.xy;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: /* glsl */ `
			uniform float light;
			uniform float radius;
			varying vec2 vLocal;
			void main() {
				float r = length(vLocal) / radius;
				float ring = smoothstep(0.84, 0.99, r);
				// Squared by hand: pow() is undefined for a negative base,
				// and a GPU that returns NaN there blooms it across the jar.
				float off = (r - 0.68) / 0.09;
				float dip = exp(-off * off);
				float k = 1.35 - dip * 0.2 + ring * 1.3;
				vec3 hue = mix(vec3(1.0, 0.62, 0.11), vec3(1.0, 0.86, 0.38), ring);
				gl_FragColor = vec4(hue * k * light, 1.0);
			}
		`,
	})
}

/** The glass's neck, just under the cap: white hot where it meets the
 *  cap, gold below. */
function createCollarMaterial(uniforms: LanternUniforms) {
	return new ShaderMaterial({
		uniforms: {
			light: uniforms.light,
			top: { value: lanternGlass.top },
		},
		side: DoubleSide,
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
		// Additive blending weights the color by alpha unless it is
		// premultiplied; these add light and leave the alpha alone.
		premultipliedAlpha: true,
		vertexShader: /* glsl */ `
			varying float vHeight;
			void main() {
				vHeight = position.y;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: /* glsl */ `
			uniform float light;
			uniform float top;
			varying float vHeight;
			void main() {
				float below = top - vHeight;
				float hot = exp(-below / 0.045);
				float warm = exp(-below / 0.07);
				vec3 color = vec3(1.0, 0.92, 0.32) * hot * 3.2 + ${glslAmber} * warm * 1.1;
				gl_FragColor = vec4(color * light, 0.0);
			}
		`,
	})
}

/** Stars adrift in the jar. Each is a sprite that faces the camera: a
 *  white core in a gold halo, and on the bright ones two faint rays. They
 *  circle the axis, bob, and twinkle. */
function createStarGeometry() {
	const random = seeded(11)
	const count = starTiers.reduce((sum, tier) => sum + tier.count, 0)
	const seeds = new Float32Array(count * 4)
	const shapes = new Float32Array(count * 4)
	const extras = new Float32Array(count * 2)
	const between = (range: readonly [number, number]) =>
		range[0] + random() * (range[1] - range[0])
	let index = 0
	for (const tier of starTiers) {
		for (let n = 0; n < tier.count; n++, index++) {
			// Inside the glass's inner wall, clear of the floor and the cap.
			const point = starPoint(random)
			seeds.set(
				[
					point.x * 0.93,
					point.y * 0.68 + 0.05,
					point.z * 0.93,
					random() * Math.PI * 2,
				],
				index * 4,
			)
			shapes.set(
				[tier.size, between(tier.core), between(tier.halo), between(tier.peak)],
				index * 4,
			)
			extras.set(
				[tier.rays ? random() * Math.PI : -1, 0.5 + random() * 1.6],
				index * 2,
			)
		}
	}
	const quad = new PlaneGeometry(1, 1)
	const geometry = new InstancedBufferGeometry()
	geometry.index = quad.index
	geometry.setAttribute('position', quad.attributes.position!)
	geometry.setAttribute('seed', new InstancedBufferAttribute(seeds, 4))
	geometry.setAttribute('shape', new InstancedBufferAttribute(shapes, 4))
	geometry.setAttribute('extra', new InstancedBufferAttribute(extras, 2))
	geometry.instanceCount = count
	return geometry
}

/**
 * A point in the unit ball, denser toward its surface as
 * 1 / sqrt(1 - r^2): the density whose projection is even, so from any
 * side the stars spread evenly across the glass, as in the art, rather
 * than crowding its middle.
 */
function starPoint(random: () => number) {
	const share = random()
	// The share of such a ball within radius u is
	// (asin(u) - u sqrt(1 - u^2)) / (pi / 2).
	let low = 0
	let high = 1
	for (let step = 0; step < 24; step++) {
		const u = (low + high) / 2
		const within = (Math.asin(u) - u * Math.sqrt(1 - u * u)) / (Math.PI / 2)
		if (within < share) low = u
		else high = u
	}
	const radius = (low + high) / 2
	const y = random() * 2 - 1
	const around = random() * Math.PI * 2
	const ring = Math.sqrt(1 - y * y)
	return new Vector3(
		radius * ring * Math.cos(around),
		radius * y,
		radius * ring * Math.sin(around),
	)
}

function createStarMaterial(uniforms: LanternUniforms) {
	return new ShaderMaterial({
		uniforms: { time: uniforms.time, sparkle: uniforms.sparkle },
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
		premultipliedAlpha: true,
		vertexShader: /* glsl */ `
			uniform float time;
			uniform float sparkle;
			attribute vec4 seed;
			attribute vec4 shape;
			attribute vec2 extra;
			varying vec2 vQ;
			varying vec3 vShape;
			varying float vPeak;
			varying float vRay;
			void main() {
				float angle = time * (0.05 + 0.03 * sin(seed.w)) + seed.w * 0.1;
				float c = cos(angle);
				float s = sin(angle);
				vec3 p = vec3(c * seed.x - s * seed.z, seed.y, s * seed.x + c * seed.z);
				p.y += sin(time * 0.4 + seed.w * 3.0) * 0.02;
				vec4 viewPosition = modelViewMatrix * vec4(p, 1.0);
				vQ = position.xy * 2.0 * shape.x;
				viewPosition.xy += vQ;
				float rays = step(0.0, extra.x);
				float twinkle = sin(time * extra.y + seed.w * 7.0);
				vPeak = shape.w * (1.0 + twinkle * mix(0.35, 0.12, rays)) * sparkle;
				vShape = shape.xyz;
				vRay = extra.x;
				gl_Position = projectionMatrix * viewPosition;
			}
		`,
		fragmentShader: /* glsl */ `
			varying vec2 vQ;
			varying vec3 vShape;
			varying float vPeak;
			varying float vRay;
			void main() {
				float d = length(vQ);
				float core = exp(-(d * d) / (vShape.y * vShape.y));
				float halo = exp(-d / vShape.z);
				float rays = 0.0;
				if (vRay >= 0.0) {
					for (int i = 0; i < 2; i++) {
						float a = vRay + float(i) * 1.15;
						vec2 along = vec2(cos(a), sin(a));
						float x = abs(dot(vQ, along));
						float y = abs(dot(vQ, vec2(-along.y, along.x)));
						rays += exp(-y / 0.0018 - x / 0.04);
					}
				}
				float fade = 1.0 - smoothstep(0.6, 1.0, d / vShape.x);
				// The core is gold too, only bright enough that the tone curve
				// takes it to white, so its bloom stays gold.
				vec3 color = vec3(1.0, 0.62, 0.18) * core +
					vec3(1.0, 0.45, 0.04) * (halo * 0.3 + rays * 0.1);
				gl_FragColor = vec4(color * vPeak * fade, 0.0);
			}
		`,
	})
}

/** A glossy marble with its primitive's glyph on the face toward the
 *  camera: the white of the glyph glows, its outline is pressed in. */
function createOrbMaterial(
	palette: readonly [string, string, string],
	glyph: Texture,
	glow: { value: number },
) {
	const [light, mid] = palette
	const material = new MeshPhysicalMaterial({
		color: mid,
		metalness: 0,
		roughness: 0.3,
		clearcoat: 1,
		clearcoatRoughness: 0.04,
		emissive: mid,
		emissiveIntensity: 0.32,
		envMapIntensity: 1.1,
	})
	const rimColor = new Color(light)
	material.onBeforeCompile = (shader) => {
		shader.uniforms.glyphMap = { value: glyph }
		shader.uniforms.glow = glow
		shader.uniforms.rimColor = { value: rimColor }
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nvarying vec3 vOrb;')
			.replace(
				'#include <begin_vertex>',
				'#include <begin_vertex>\nvOrb = position;',
			)
		shader.fragmentShader = shader.fragmentShader
			.replace(
				'#include <common>',
				`#include <common>
				uniform sampler2D glyphMap;
				uniform float glow;
				uniform vec3 rimColor;
				varying vec3 vOrb;`,
			)
			.replace(
				'#include <emissivemap_fragment>',
				`#include <emissivemap_fragment>
				{
					vec3 along = normalize(vOrb);
					float front = smoothstep(0.25, 0.55, along.z);
					vec4 mark = texture2D(glyphMap, along.xy * ${glyphSpan.toFixed(3)} + 0.5);
					float ink = mark.a * front;
					float shine = clamp(dot(mark.rgb, vec3(0.3333)), 0.0, 1.0) * ink;
					diffuseColor.rgb *= 1.0 - 0.7 * clamp(ink - shine, 0.0, 1.0);
					diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.96, 0.88), shine * 0.7);
					float facing = saturate(dot(normal, normalize(vViewPosition)));
					float rim = pow(1.0 - facing, 2.4);
					totalEmissiveRadiance += rimColor * rim * 0.9;
					totalEmissiveRadiance += vec3(1.0, 0.95, 0.86) * shine * 1.6;
				}`,
			)
			// As the 2D orbs' brightness filter: the lit orb brightens and
			// the rest dim.
			.replace(
				'#include <opaque_fragment>',
				'outgoingLight *= glow;\n#include <opaque_fragment>',
			)
	}
	material.customProgramCacheKey = () => 'lantern-orb'
	return material
}

/** Pass the vertex's object-space position and normal to the fragment. */
function withObjectSpace(shader: WebGLProgramParametersWithUniforms) {
	shader.vertexShader = shader.vertexShader
		.replace(
			'#include <common>',
			`#include <common>
			varying vec3 vObjectPosition;
			varying vec3 vObjectNormal;`,
		)
		.replace(
			'#include <begin_vertex>',
			`#include <begin_vertex>
			vObjectPosition = transformed;
			vObjectNormal = objectNormal;`,
		)
}

/**
 * A tiling height field for the hammered finish, as a normal map in RG
 * and the height in A: shallow dimples (cellular noise) under a fine
 * crinkle (value noise). B holds the dimples' borders, the faint web in
 * the jar's haze. Built once, on the CPU, in a few milliseconds.
 */
function createGrainTexture(size = 256) {
	const random = seeded(5)
	const cells = 18
	const features = Array.from({ length: cells * cells }, () => [
		random(),
		random(),
	])
	const lattice = 32
	const values = Array.from({ length: lattice * lattice }, () => random())
	const latticeAt = (x: number, y: number) =>
		values[
			(((y % lattice) + lattice) % lattice) * lattice +
				(((x % lattice) + lattice) % lattice)
		]!
	const crinkle = (u: number, v: number) => {
		const x = Math.floor(u)
		const y = Math.floor(v)
		const fx = u - x
		const fy = v - y
		const sx = fx * fx * (3 - 2 * fx)
		const sy = fy * fy * (3 - 2 * fy)
		const top = latticeAt(x, y) + (latticeAt(x + 1, y) - latticeAt(x, y)) * sx
		const bottom =
			latticeAt(x, y + 1) + (latticeAt(x + 1, y + 1) - latticeAt(x, y + 1)) * sx
		return top + (bottom - top) * sy
	}
	const height = new Float32Array(size * size)
	const web = new Float32Array(size * size)
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const u = (x / size) * cells
			const v = (y / size) * cells
			const cx = Math.floor(u)
			const cy = Math.floor(v)
			let nearest = Infinity
			let second = Infinity
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const gx = (cx + dx + cells) % cells
					const gy = (cy + dy + cells) % cells
					const feature = features[gy * cells + gx]!
					const px = cx + dx + feature[0]!
					const py = cy + dy + feature[1]!
					const distance = (u - px) ** 2 + (v - py) ** 2
					if (distance < nearest) {
						second = nearest
						nearest = distance
					} else if (distance < second) {
						second = distance
					}
				}
			}
			const dimple = Math.min(Math.sqrt(nearest), 1)
			const fine =
				crinkle((x / size) * lattice, (y / size) * lattice) * 0.65 +
				crinkle((x / size) * lattice * 2, (y / size) * lattice * 2) * 0.35
			height[y * size + x] = dimple * dimple * 0.75 + fine * 0.25
			const gap = Math.sqrt(second) - Math.sqrt(nearest)
			web[y * size + x] = Math.max(0, 1 - gap / 0.09) ** 2
		}
	}
	const data = new Uint8Array(size * size * 4)
	const at = (x: number, y: number) =>
		height[((y + size) % size) * size + ((x + size) % size)]!
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = (at(x + 1, y) - at(x - 1, y)) * 2.2
			const dy = (at(x, y + 1) - at(x, y - 1)) * 2.2
			const i = (y * size + x) * 4
			data[i] = Math.round(Math.min(Math.max(0.5 - dx, 0), 1) * 255)
			data[i + 1] = Math.round(Math.min(Math.max(0.5 - dy, 0), 1) * 255)
			data[i + 2] = Math.round(web[y * size + x]! * 255)
			data[i + 3] = Math.round(at(x, y) * 255)
		}
	}
	const texture = new DataTexture(data, size, size)
	texture.wrapS = RepeatWrapping
	texture.wrapT = RepeatWrapping
	texture.magFilter = LinearFilter
	texture.minFilter = LinearMipmapLinearFilter
	texture.generateMipmaps = true
	texture.needsUpdate = true
	return texture
}

/** Mulberry32: the same stars and grain on every load. */
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
