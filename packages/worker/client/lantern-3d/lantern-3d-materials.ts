import {
	AdditiveBlending,
	BackSide,
	Color,
	CustomBlending,
	DataTexture,
	FrontSide,
	LinearFilter,
	MeshBasicMaterial,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	NormalBlending,
	OneFactor,
	OneMinusSrcAlphaFactor,
	RGBAFormat,
	ShaderMaterial,
	SpriteMaterial,
	UnsignedByteType,
	type Texture,
} from 'three'

/**
 * Materials for the 3D lantern, physically based where light falls on a
 * surface. The glass holds Kody's lantern light in three layers: inside,
 * the fluid is deep amber where you look straight through and turns gold
 * toward the walls, with light rippling over the floor; then the light the
 * glass wall carries, brightest where you look along it; then the studio,
 * reflected as clear glass reflects it. The metal is charcoal hammertone
 * paint under a thin clear coat. Each orb is a marble in three layers: a
 * colored core seen from inside, the glyph, and a glossy shell.
 *
 * Glows add their color weighted by alpha, so on a light page they tint
 * it and on a dark page or over the glass they brighten it. A glow that
 * wrote full alpha with dark color would paint black squares on the page.
 * Shaders end in three's tone mapping and output color space chunks so they
 * sit in the same light as the physical materials.
 */

const worldVertex = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec3 vLocalPosition;

void main() {
	vec4 world = modelMatrix * vec4(position, 1.0);
	vWorldPosition = world.xyz;
	vWorldNormal = normalize(mat3(modelMatrix) * normal);
	vLocalPosition = position;
	gl_Position = projectionMatrix * viewMatrix * world;
}
`

const outputChunks = /* glsl */ `
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
`

/** For light added over the glass: blending adds to the sRGB values
 *  already drawn, and over the glow's mid tones sRGB rises about as fast
 *  as linear light, so a linear value added there brightens it about as
 *  much as the same light would. Encoded first, a faint reflection would
 *  add several times too much and turn the glass milky. */
const linearAddChunks = /* glsl */ `
	#include <tonemapping_fragment>
`

/** Linear sRGB, before tone mapping, matched to the still: deep amber
 *  through the middle of the globe, gold toward the glass, pale yellow
 *  under the cap and over the floor. */
export const lanternAmber = {
	deep: new Color(0.34, 0.125, 0.025),
	bright: new Color(1.67, 0.89, 0.06),
	heart: new Color(0.99, 0.79, 0.38),
	hot: new Color(1, 0.8, 0.26),
	/** The hottest light, where red and green both run out and it shows
	 *  as the still's pale yellow. */
	pale: new Color(2.5, 2.4, 0.6),
	floor: new Color(1.75, 1.05, 0.02),
	/** Added over the gold under the cap, it lifts green and blue to the
	 *  pale yellow there; red has nowhere left to go. */
	neck: new Color(0.46, 0.42, 0.26),
	rim: new Color(1, 0.62, 0.12),
	edge: new Color(1, 0.72, 0.3),
	spark: new Color(1, 0.8, 0.4),
	/** What the lantern throws on the page around it. */
	glow: new Color(0.95, 0.6, 0.14),
} as const

/** Linear sRGB for the frame: charcoal paint with aluminum flake in it, so
 *  half metal. */
const lanternMetal = {
	charcoal: new Color(0.16, 0.152, 0.145),
} as const

/** Bright lines where two warped sine lattices cancel: light through the
 *  moving fluid, thrown on what is under it. */
const causticChunk = /* glsl */ `
	float caustic(vec2 p, float t) {
		vec2 q = p + vec2(sin(p.y * 1.7 + t), cos(p.x * 1.3 - t * 0.8)) * 0.6;
		float a = sin(q.x * 2.3 + t * 0.6) * sin(q.y * 2.1 - t * 0.5);
		vec2 r = p * 1.6 + vec2(cos(q.y + t * 0.7), sin(q.x - t * 0.4));
		float b = sin(r.x * 2.0) * sin(r.y * 2.4);
		return pow(1.0 - abs(a + b) * 0.5, 7.0);
	}
`

/** The far wall of the glass, seen from inside. Straight through the
 *  middle you see the fluid's own deep amber; toward the edge your line of
 *  sight runs along the glass wall, which carries the light, so it turns
 *  gold. The light gathers under the cap and pools over the floor. It
 *  writes depth so motes that drift behind the lantern stay hidden. */
export function createGlassInteriorMaterial(band: {
	top: number
	bottom: number
}) {
	return new ShaderMaterial({
		uniforms: {
			uDeep: { value: lanternAmber.deep.clone() },
			uBright: { value: lanternAmber.bright.clone() },
			uHeart: { value: lanternAmber.heart.clone() },
			uHot: { value: lanternAmber.hot.clone() },
			uGlow: { value: 1 },
			uTime: { value: 0 },
			uTop: { value: band.top },
			uBottom: { value: band.bottom },
		},
		vertexShader: worldVertex,
		fragmentShader: /* glsl */ `
			uniform vec3 uDeep;
			uniform vec3 uBright;
			uniform vec3 uHeart;
			uniform vec3 uHot;
			uniform float uGlow;
			uniform float uTime;
			uniform float uTop;
			uniform float uBottom;
			varying vec3 vWorldPosition;
			varying vec3 vWorldNormal;
			varying vec3 vLocalPosition;
			${causticChunk}

			void main() {
				vec3 view = normalize(cameraPosition - vWorldPosition);
				float facing = clamp(dot(-normalize(vWorldNormal), view), 0.0, 1.0);
				vec3 color = mix(uDeep, uBright, smoothstep(0.22, 0.75, 1.0 - facing));

				float low = smoothstep(0.45, -0.85, vLocalPosition.y);
				color += uBright * low * low * 0.12;
				float top = smoothstep(uTop - 0.26, uTop - 0.04, vLocalPosition.y);
				float bottom = smoothstep(uBottom + 0.32, uBottom, vLocalPosition.y);
				color += uHot * (top * top * 2.4 + bottom * bottom * 0.9);
				color += uHeart * caustic(vLocalPosition.xz * 2.4 + vLocalPosition.y, uTime * 0.3)
					* bottom * 0.35;

				vec3 p = vLocalPosition;
				float shimmer = sin(p.y * 7.0 + uTime * 0.9 + sin(p.x * 5.0 - uTime * 0.6))
					* sin(p.x * 6.0 - p.z * 4.0 + uTime * 0.7);
				color *= 1.0 + shimmer * 0.05;
				gl_FragColor = vec4(color * uGlow, 0.97);
				${outputChunks}
			}
		`,
		side: BackSide,
		transparent: true,
	})
}

/** The base's top seen through the glass: gold, lit from above, turning
 *  pale where the light pools in the middle, along the caustics, and in a
 *  ring where it meets the glass. */
export function createGlassFloorMaterial(radius: number) {
	return new ShaderMaterial({
		uniforms: {
			uFloor: { value: lanternAmber.floor.clone() },
			uPale: { value: lanternAmber.pale.clone() },
			uGlow: { value: 1 },
			uTime: { value: 0 },
			uRadius: { value: radius },
		},
		vertexShader: worldVertex,
		fragmentShader: /* glsl */ `
			uniform vec3 uFloor;
			uniform vec3 uPale;
			uniform float uGlow;
			uniform float uTime;
			uniform float uRadius;
			varying vec3 vLocalPosition;
			${causticChunk}

			void main() {
				float reach = length(vLocalPosition.xy) / uRadius;
				float pool = exp(-reach * reach * 9.0);
				float ring = smoothstep(0.7, 0.97, reach);
				float light = caustic(vLocalPosition.xy * 3.4, uTime * 0.3);
				vec3 color = mix(
					uFloor,
					uPale,
					clamp(pool * 0.5 + ring * 0.85 + light * 0.4, 0.0, 1.0)
				);
				gl_FragColor = vec4(color * uGlow, 1.0);
				${outputChunks}
			}
		`,
	})
}

/** The light the glass wall carries, added over the glow: it builds where
 *  you look along the wall and ends in a crisp bright edge, and it runs
 *  round the neck in a bright band just under the cap, nearest the light.
 *  The band is on the near wall: from above, the far wall's top hides
 *  behind the cap. */
export function createGlassRimMaterial(band: { top: number }) {
	return new ShaderMaterial({
		uniforms: {
			uRim: { value: lanternAmber.rim.clone() },
			uEdge: { value: lanternAmber.edge.clone() },
			uNeck: { value: lanternAmber.neck.clone() },
			uTop: { value: band.top },
		},
		vertexShader: worldVertex,
		fragmentShader: /* glsl */ `
			uniform vec3 uRim;
			uniform vec3 uEdge;
			uniform vec3 uNeck;
			uniform float uTop;
			varying vec3 vWorldPosition;
			varying vec3 vWorldNormal;
			varying vec3 vLocalPosition;

			void main() {
				vec3 view = normalize(cameraPosition - vWorldPosition);
				float facing = clamp(dot(normalize(vWorldNormal), view), 0.0, 1.0);
				float along = pow(1.0 - facing, 3.0);
				float edge = pow(1.0 - facing, 9.0);
				float below = max(uTop - vLocalPosition.y, 0.0);
				float neck = 1.0 - smoothstep(0.025, 0.065, below);
				float spill = exp(-below * 12.0);
				gl_FragColor = vec4(
					uRim * along * 0.3 + uEdge * edge * 0.7 + uNeck * (neck * 0.85 + spill * 0.5),
					1.0
				);
				${linearAddChunks}
			}
		`,
		side: FrontSide,
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
	})
}

/** The studio's share of a reflection: one read of the environment,
 *  weighted by three's own split-sum Fresnel term. On a black surface
 *  three's diffuse light, the irradiance read behind it, and its multiple
 *  scattering (next to nothing this smooth) add nothing visible, and
 *  skipping them saves a second read of the environment at every pixel of
 *  the globe. */
const reflectedStudioChunk = /* glsl */ `
	#ifdef USE_ENVMAP
		reflectedLight.indirectSpecular +=
			getIBLRadiance(geometryViewDir, geometryNormal, material.roughness)
			* (material.specularColor * material.dfg.x + material.specularF90 * material.dfg.y);
	#endif
`

/**
 * What a clear surface reflects and nothing else: black, so it has no
 * diffuse light of its own, added over whatever is under it. Fresnel makes
 * it faint face-on, so the glow and the orbs show through, and mirror
 * bright toward the edges.
 */
function createReflectionLayer(options: {
	roughness: number
	ior: number
	cacheKey: string
	patch?: (fragmentShader: string) => string
}) {
	const material = new MeshPhysicalMaterial({
		color: 0x000000,
		metalness: 0,
		roughness: options.roughness,
		ior: options.ior,
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
	})
	material.onBeforeCompile = (shader) => {
		const reflected = shader.fragmentShader
			.replace('#include <lights_fragment_maps>', reflectedStudioChunk)
			.replace('#include <lights_fragment_end>', '')
		shader.fragmentShader = options.patch?.(reflected) ?? reflected
	}
	material.customProgramCacheKey = () => options.cacheKey
	return material
}

/** The studio in the outside of the glass, added in linear light. Its
 *  reflections are worked out from the environment map, so they stay put
 *  while the globe turns, as they would on real glass. It leaves out the
 *  punctual lights: on near-mirror glass a directional light is a pinprick
 *  that flickers as the lantern sways, and its softbox in the studio
 *  already shows where it is. */
export function createGlassReflectionMaterial() {
	return createReflectionLayer({
		roughness: 0.04,
		ior: 1.5,
		cacheKey: 'lantern-glass-reflection',
		patch: (fragmentShader) =>
			fragmentShader
				.replace(
					'#include <lights_physical_pars_fragment>',
					'#include <lights_physical_pars_fragment>\n#undef RE_Direct',
				)
				.replace('#include <colorspace_fragment>', ''),
	})
}

/**
 * A fine raised wrinkle, as hammertone paint dries: lines where gradient
 * noise crosses zero, a coarse set and a fine one across it, in the part's
 * own units so it sticks to the part and has no seams. Each set fades out
 * where a pixel spans one of its wrinkles, so the paint never shimmers;
 * what it loses there turns into a little more roughness. The bump uses
 * unnormalized screen derivatives, so it is the same relief at any
 * resolution.
 */
const hammerChunk = /* glsl */ `
	varying vec3 vHammer;

	vec3 hammerHash(vec3 p) {
		p = fract(p * vec3(0.1031, 0.103, 0.0973));
		p += dot(p, p.yxz + 33.33);
		return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
	}

	float hammerCorner(vec3 cell, vec3 f, vec3 corner) {
		return dot(hammerHash(cell + corner), f - corner);
	}

	float hammerNoise(vec3 p) {
		vec3 cell = floor(p);
		vec3 f = p - cell;
		vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
		return mix(
			mix(
				mix(hammerCorner(cell, f, vec3(0.0, 0.0, 0.0)), hammerCorner(cell, f, vec3(1.0, 0.0, 0.0)), u.x),
				mix(hammerCorner(cell, f, vec3(0.0, 1.0, 0.0)), hammerCorner(cell, f, vec3(1.0, 1.0, 0.0)), u.x),
				u.y
			),
			mix(
				mix(hammerCorner(cell, f, vec3(0.0, 0.0, 1.0)), hammerCorner(cell, f, vec3(1.0, 0.0, 1.0)), u.x),
				mix(hammerCorner(cell, f, vec3(0.0, 1.0, 1.0)), hammerCorner(cell, f, vec3(1.0, 1.0, 1.0)), u.x),
				u.y
			),
			u.z
		);
	}

	const float hammerCoarse = 46.0;
	const float hammerFine = 103.0;
	/** World units of relief at the top of a wrinkle. */
	const float hammerDepth = 0.0013;

	float hammerShare(float footprint, float frequency) {
		return 1.0 - smoothstep(0.1, 0.3, footprint * frequency);
	}

	float hammerHeight(vec3 p, float footprint) {
		float coarse = pow(1.0 - abs(hammerNoise(p * hammerCoarse)), 6.0);
		float fine = pow(1.0 - abs(hammerNoise(p.zxy * hammerFine + 11.0)), 3.0);
		return coarse * 0.75 * hammerShare(footprint, hammerCoarse)
			+ fine * 0.25 * hammerShare(footprint, hammerFine);
	}

	vec3 hammerNormal(vec3 position, vec3 normal, vec2 slope, float faceDirection) {
		vec3 sigmaX = dFdx(position);
		vec3 sigmaY = dFdy(position);
		vec3 r1 = cross(sigmaY, normal);
		vec3 r2 = cross(normal, sigmaX);
		float det = dot(sigmaX, r1) * faceDirection;
		vec3 grad = sign(det) * (slope.x * r1 + slope.y * r2);
		return normalize(abs(det) * normal - grad);
	}
`

/** Charcoal hammertone paint for the cap, handle, and base, under a thin
 *  clear coat that stays smooth over the wrinkle. */
export function createMetalMaterial() {
	const material = new MeshPhysicalMaterial({
		color: lanternMetal.charcoal.clone(),
		metalness: 0.5,
		roughness: 0.42,
		clearcoat: 0.4,
		clearcoatRoughness: 0.28,
		dithering: true,
	})
	material.onBeforeCompile = (shader) => {
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nvarying vec3 vHammer;')
			.replace(
				'#include <begin_vertex>',
				'#include <begin_vertex>\nvHammer = transformed;',
			)
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', `#include <common>\n${hammerChunk}`)
			.replace(
				'#include <roughnessmap_fragment>',
				/* glsl */ `#include <roughnessmap_fragment>
				float hammerFootprint = max(length(dFdx(vHammer)), length(dFdy(vHammer)));
				float hammer = hammerHeight(vHammer, hammerFootprint);
				roughnessFactor = clamp(
					roughnessFactor + (0.3 - hammer) * 0.2
						+ (1.0 - hammerShare(hammerFootprint, hammerCoarse)) * 0.05,
					0.1,
					1.0
				);
				diffuseColor.rgb *= 0.9 + hammer * 0.25;`,
			)
			.replace(
				'#include <normal_fragment_maps>',
				/* glsl */ `#include <normal_fragment_maps>
				normal = hammerNormal(
					-vViewPosition,
					normal,
					vec2(dFdx(hammer), dFdy(hammer)) * hammerDepth,
					faceDirection
				);`,
			)
	}
	material.customProgramCacheKey = () => 'lantern-hammertone'
	return material
}

/** Where the glass meets the cap and the base. */
export function createLitEdgeMaterial() {
	return new MeshBasicMaterial({
		color: lanternAmber.pale.clone(),
	})
}

const hashChunk = /* glsl */ `
	float hash(vec3 p) {
		p = fract(p * 0.3183099 + 0.1);
		p *= 17.0;
		return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
	}
`

/**
 * The inside of an orb: its primitive color, deeper toward the edge and
 * then pale and bright at the rim, where you look through the most glass,
 * with star specks that twinkle and roll with the orb.
 */
export function createOrbCoreMaterial(seed: number) {
	return new ShaderMaterial({
		uniforms: {
			uColor: { value: new Color(1, 1, 1) },
			uLit: { value: 0 },
			uDim: { value: 0 },
			uTime: { value: 0 },
			uSeed: { value: seed },
		},
		vertexShader: worldVertex,
		fragmentShader: /* glsl */ `
			uniform vec3 uColor;
			uniform float uLit;
			uniform float uDim;
			uniform float uTime;
			uniform float uSeed;
			varying vec3 vWorldPosition;
			varying vec3 vWorldNormal;
			varying vec3 vLocalPosition;
			${hashChunk}

			void main() {
				vec3 view = normalize(cameraPosition - vWorldPosition);
				float facing = clamp(dot(-normalize(vWorldNormal), view), 0.0, 1.0);
				vec3 color = uColor * mix(0.45, 1.15, pow(facing, 1.6));
				color = mix(color, mix(uColor, vec3(1.0), 0.45) * 1.5, pow(1.0 - facing, 3.0));

				vec3 dir = normalize(vLocalPosition) * 7.0 + uSeed;
				vec3 cell = floor(dir);
				float pick = hash(cell);
				float speck = step(0.62, pick)
					* smoothstep(0.24, 0.0, length(fract(dir) - 0.5));
				float twinkle = 0.55 + 0.45 * sin(uTime * (1.3 + pick * 3.2) + pick * 40.0);
				color += mix(uColor, vec3(1.0), 0.6) * speck * twinkle * 1.3;

				color *= (1.0 + uLit * 0.45) * mix(1.0, 0.4, uDim);
				gl_FragColor = vec4(color, 1.0);
				${outputChunks}
			}
		`,
		side: BackSide,
	})
}

/** The glossy outside of an orb: the studio's softboxes and the lights'
 *  glints, clear in the middle so the glyph shows through. */
export function createOrbShellMaterial() {
	return createReflectionLayer({
		roughness: 0.08,
		ior: 1.55,
		cacheKey: 'lantern-orb-shell',
	})
}

/** A glyph glows a pale tint of its orb's color; its clear coat catches
 *  the lights on the bevels. */
export function createGlyphMaterial() {
	return new MeshPhysicalMaterial({
		color: 0xffffff,
		emissive: 0xffffff,
		emissiveIntensity: 0.85,
		roughness: 0.35,
		metalness: 0,
		clearcoat: 1,
		clearcoatRoughness: 0.12,
		envMapIntensity: 0.6,
	})
}

/** The line round a glyph, in a deep shade of its orb's color. */
export function createKeylineMaterial() {
	return new MeshStandardMaterial({
		color: 0x000000,
		roughness: 0.4,
		metalness: 0,
	})
}

/** White disc with a soft falloff, for halos, the light pool, and the
 *  contact shadow. */
export function createGlowTexture(): Texture {
	const size = 128
	const data = new Uint8Array(size * size * 4)
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = ((x + 0.5) / size) * 2 - 1
			const dy = ((y + 0.5) / size) * 2 - 1
			const reach = Math.min(Math.hypot(dx, dy), 1)
			const index = (y * size + x) * 4
			data[index] = 255
			data[index + 1] = 255
			data[index + 2] = 255
			data[index + 3] = Math.round((1 - reach) ** 2.2 * 255)
		}
	}
	const texture = new DataTexture(
		data,
		size,
		size,
		RGBAFormat,
		UnsignedByteType,
	)
	texture.magFilter = LinearFilter
	texture.minFilter = LinearFilter
	texture.generateMipmaps = false
	texture.needsUpdate = true
	return texture
}

export function createGlowMaterial(
	map: Texture,
	options: { color: Color; opacity: number },
) {
	return new SpriteMaterial({
		map,
		color: options.color,
		opacity: options.opacity,
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
	})
}

/** A soft dark ellipse under the base. */
export function createShadowMaterial(map: Texture) {
	return new MeshBasicMaterial({
		map,
		color: 0x000000,
		opacity: 0.3,
		transparent: true,
		depthWrite: false,
		blending: NormalBlending,
	})
}

/** Warm light the globe throws on the ground. */
export function createPoolMaterial(map: Texture) {
	return new MeshBasicMaterial({
		map,
		color: lanternAmber.glow.clone(),
		opacity: 0.5,
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
	})
}

const pointVertexHead = /* glsl */ `
	uniform float uTime;
	uniform float uScale;
	attribute float aSize;
	attribute float aSeed;
`

const pointFragmentDisc = /* glsl */ `
	vec2 point = gl_PointCoord * 2.0 - 1.0;
	float reach = length(point);
	if (reach > 1.0) discard;
	float core = smoothstep(0.32, 0.0, reach);
	float halo = pow(1.0 - reach, 3.0) * 0.55;
`

/** Sparkles inside the glass. They turn with the fluid, as the orbs do, and
 *  drift a little on their own; the big ones flare into four-point stars
 *  like the still. */
export function createSparkleMaterial() {
	return new ShaderMaterial({
		uniforms: {
			uTime: { value: 0 },
			uScale: { value: 1 },
			uSwirl: { value: 0 },
			uColor: { value: lanternAmber.spark.clone().multiplyScalar(1.5) },
			uGlow: { value: 1 },
		},
		vertexShader: /* glsl */ `
			${pointVertexHead}
			uniform float uSwirl;
			varying float vLight;
			varying float vFlare;

			void main() {
				vec3 p = position;
				float angle = uSwirl + uTime * (0.03 + aSeed * 0.04);
				float s = sin(angle);
				float c = cos(angle);
				p.xz = mat2(c, -s, s, c) * p.xz;
				p.y += sin(uTime * (0.3 + aSeed * 0.45) + aSeed * 31.0) * 0.035;
				vec4 view = modelViewMatrix * vec4(p, 1.0);
				gl_Position = projectionMatrix * view;
				gl_PointSize = aSize * uScale / -view.z;
				float twinkle = 0.5 + 0.5 * sin(uTime * (1.0 + aSeed * 2.4) + aSeed * 57.0);
				vLight = 0.4 + 0.6 * twinkle * twinkle;
				vFlare = smoothstep(0.065, 0.1, aSize);
			}
		`,
		fragmentShader: /* glsl */ `
			uniform vec3 uColor;
			uniform float uGlow;
			varying float vLight;
			varying float vFlare;

			void main() {
				${pointFragmentDisc}
				float flare = (max(0.0, 1.0 - abs(point.x) * 10.0) * (1.0 - abs(point.y))
					+ max(0.0, 1.0 - abs(point.y) * 10.0) * (1.0 - abs(point.x))) * vFlare;
				float light = clamp((core + halo * 0.7 + flare) * vLight * uGlow, 0.0, 1.0);
				gl_FragColor = vec4(uColor, light);
				${outputChunks}
			}
		`,
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
	})
}

/** Fireflies drawn to the light: slow loops around the globe with a lazy
 *  bob, some passing in front and some behind. */
export function createFireflyMaterial() {
	return new ShaderMaterial({
		uniforms: {
			uTime: { value: 0 },
			uScale: { value: 1 },
			uColor: { value: lanternAmber.glow.clone().multiplyScalar(1.25) },
			uOpacity: { value: 1 },
		},
		vertexShader: /* glsl */ `
			${pointVertexHead}
			varying float vAlpha;

			void main() {
				float orbit = position.x;
				float height = position.y;
				float speed = position.z;
				float angle = aSeed * 6.2832 + uTime * speed;
				vec3 p = vec3(
					cos(angle) * orbit,
					height + sin(uTime * (0.5 + aSeed * 0.6) + aSeed * 13.0) * 0.16,
					sin(angle) * orbit * 0.8
				);
				p.x += sin(uTime * (0.9 + aSeed) + aSeed * 20.0) * 0.05;
				float blink = sin(uTime * (0.6 + aSeed * 0.9) + aSeed * 9.0);
				vAlpha = smoothstep(-0.35, 0.6, blink);
				vec4 view = modelViewMatrix * vec4(p, 1.0);
				gl_Position = projectionMatrix * view;
				gl_PointSize = aSize * uScale / -view.z;
			}
		`,
		fragmentShader: /* glsl */ `
			uniform vec3 uColor;
			uniform float uOpacity;
			varying float vAlpha;

			void main() {
				${pointFragmentDisc}
				gl_FragColor = vec4(uColor, clamp((core + halo) * vAlpha * uOpacity, 0.0, 1.0));
				${outputChunks}
			}
		`,
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
	})
}

/** The idle constellation: motes laid orb to orb. A white-hot head runs
 *  along them trailing a tail in the orbs' colors; once it reaches the
 *  last orb the whole thread lights, holds, and fades. Light added alone
 *  washes out on the bright glass, so each mote also covers some of what
 *  is behind it (premultiplied over) and its color reads on the pale
 *  heart as well as on the deep amber. */
export function createThreadMaterial() {
	return new ShaderMaterial({
		uniforms: {
			uScale: { value: 1 },
			uHead: { value: 0 },
			uGlow: { value: 0 },
			uSettle: { value: 0 },
		},
		vertexShader: /* glsl */ `
			uniform float uScale;
			uniform float uHead;
			uniform float uGlow;
			uniform float uSettle;
			attribute float aAlong;
			attribute vec3 aColor;
			varying vec3 vColor;
			varying float vLight;
			varying float vHot;

			void main() {
				float behind = uHead - aAlong;
				float tail = exp(-max(behind, 0.0) * 1.4);
				vHot = exp(-max(behind, 0.0) * 14.0);
				vLight = behind < 0.0 ? 0.0 : max(tail, uSettle * 0.8) * uGlow;
				vColor = aColor;
				vec4 view = modelViewMatrix * vec4(position, 1.0);
				gl_Position = projectionMatrix * view;
				gl_PointSize = vLight > 0.0 ? (0.075 + 0.08 * vHot) * uScale / -view.z : 0.0;
			}
		`,
		fragmentShader: /* glsl */ `
			varying vec3 vColor;
			varying float vLight;
			varying float vHot;

			void main() {
				${pointFragmentDisc}
				gl_FragColor = vec4(mix(vColor, vec3(1.0), vHot * 0.8) * (1.0 + vHot * 1.5), 1.0);
				${outputChunks}
				gl_FragColor = vec4(
					gl_FragColor.rgb * clamp((core + halo) * vLight, 0.0, 1.0),
					clamp((core * 0.9 + halo * 0.7) * vLight, 0.0, 1.0)
				);
			}
		`,
		transparent: true,
		depthWrite: false,
		blending: CustomBlending,
		blendSrc: OneFactor,
		blendDst: OneMinusSrcAlphaFactor,
	})
}

/** One-shot sparks from a booped orb. Each spark carries its birth time. */
export function createBurstMaterial() {
	return new ShaderMaterial({
		uniforms: {
			uTime: { value: 0 },
			uScale: { value: 1 },
		},
		vertexShader: /* glsl */ `
			uniform float uTime;
			uniform float uScale;
			attribute vec3 aVelocity;
			attribute vec3 aColor;
			attribute float aBirth;
			varying vec3 vColor;
			varying float vAlpha;

			void main() {
				float age = uTime - aBirth;
				float life = 1.0;
				float fade = 1.0 - clamp(age / life, 0.0, 1.0);
				vAlpha = age < 0.0 ? 0.0 : fade * fade;
				vColor = aColor;
				float travel = age - age * age * 0.35;
				vec3 p = position + aVelocity * travel - vec3(0.0, 0.18, 0.0) * age * age;
				vec4 view = modelViewMatrix * vec4(p, 1.0);
				gl_Position = projectionMatrix * view;
				gl_PointSize = vAlpha > 0.0 ? (0.03 + 0.04 * fade) * uScale / -view.z : 0.0;
			}
		`,
		fragmentShader: /* glsl */ `
			varying vec3 vColor;
			varying float vAlpha;

			void main() {
				${pointFragmentDisc}
				gl_FragColor = vec4(vColor * 1.8, clamp((core + halo) * vAlpha, 0.0, 1.0));
				${outputChunks}
			}
		`,
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
	})
}
