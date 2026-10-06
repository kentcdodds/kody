import {
	AdditiveBlending,
	BackSide,
	Color,
	DataTexture,
	FrontSide,
	LinearFilter,
	MeshBasicMaterial,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	NormalBlending,
	RGBAFormat,
	ShaderMaterial,
	SpriteMaterial,
	UnsignedByteType,
	type Texture,
} from 'three'

/**
 * Materials for the 3D lantern. The glass is the still's warm amber: an
 * opaque interior that glows brighter where it faces you, a hot rim, and
 * clear-coat reflections added on top. Each orb is a marble in three
 * layers: a colored core seen from inside, the glyph, and a glossy shell.
 *
 * Glows add their color weighted by alpha, so on a light page they tint
 * it and on a dark page or over the glass they brighten it. A glow that
 * wrote full alpha with dark color would paint black squares on the page.
 * Shaders end in three's tone mapping and output color space chunks so they
 * sit in the same light as the standard materials.
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

/** Linear sRGB, sampled off the still: deep amber glass between bright
 *  sparkles, over a floor that glows yellow. */
export const lanternAmber = {
	deep: new Color(0.27, 0.085, 0.004),
	bright: new Color(0.58, 0.22, 0.012),
	hot: new Color(1, 0.6, 0.12),
	floor: new Color(1.15, 0.66, 0.07),
	rim: new Color(1, 0.72, 0.34),
	spark: new Color(1, 0.8, 0.4),
	/** What the lantern throws on the page around it. */
	glow: new Color(1, 0.52, 0.06),
} as const

/** The far wall of the glass, seen from inside. It writes depth so motes
 *  that drift behind the lantern stay hidden. */
export function createGlassInteriorMaterial(band: {
	top: number
	bottom: number
}) {
	return new ShaderMaterial({
		uniforms: {
			uDeep: { value: lanternAmber.deep.clone() },
			uBright: { value: lanternAmber.bright.clone() },
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
			uniform vec3 uHot;
			uniform float uGlow;
			uniform float uTime;
			uniform float uTop;
			uniform float uBottom;
			varying vec3 vWorldPosition;
			varying vec3 vWorldNormal;
			varying vec3 vLocalPosition;

			void main() {
				vec3 view = normalize(cameraPosition - vWorldPosition);
				float facing = clamp(dot(-normalize(vWorldNormal), view), 0.0, 1.0);
				vec3 color = mix(uDeep, uBright, pow(facing, 1.25));
				float top = smoothstep(uTop - 0.16, uTop, vLocalPosition.y);
				float bottom = smoothstep(uBottom + 0.3, uBottom, vLocalPosition.y);
				color += uHot * (top * top * 0.85 + bottom * bottom * 0.8);
				vec3 p = vLocalPosition;
				float shimmer = sin(p.y * 7.0 + uTime * 0.9 + sin(p.x * 5.0 - uTime * 0.6))
					* sin(p.x * 6.0 - p.z * 4.0 + uTime * 0.7);
				color *= 1.0 + shimmer * 0.06;
				gl_FragColor = vec4(color * uGlow, 0.97);
				${outputChunks}
			}
		`,
		side: BackSide,
		transparent: true,
	})
}

/** The base's top seen through the glass: lit from above and brightest in
 *  a ring where it meets the glass. */
export function createGlassFloorMaterial(radius: number) {
	return new ShaderMaterial({
		uniforms: {
			uFloor: { value: lanternAmber.floor.clone() },
			uHot: { value: lanternAmber.hot.clone() },
			uGlow: { value: 1 },
			uRadius: { value: radius },
		},
		vertexShader: worldVertex,
		fragmentShader: /* glsl */ `
			uniform vec3 uFloor;
			uniform vec3 uHot;
			uniform float uGlow;
			uniform float uRadius;
			varying vec3 vLocalPosition;

			void main() {
				float reach = length(vLocalPosition.xy) / uRadius;
				float ring = smoothstep(0.62, 0.95, reach);
				vec3 color = uFloor * (0.82 + 0.18 * reach) + uHot * ring * 0.45;
				gl_FragColor = vec4(color * uGlow, 1.0);
				${outputChunks}
			}
		`,
	})
}

export function createGlassRimMaterial() {
	return new ShaderMaterial({
		uniforms: {
			uRim: { value: lanternAmber.rim.clone() },
			uStrength: { value: 1.2 },
		},
		vertexShader: worldVertex,
		fragmentShader: /* glsl */ `
			uniform vec3 uRim;
			uniform float uStrength;
			varying vec3 vWorldPosition;
			varying vec3 vWorldNormal;
			varying vec3 vLocalPosition;

			void main() {
				vec3 view = normalize(cameraPosition - vWorldPosition);
				float facing = clamp(dot(normalize(vWorldNormal), view), 0.0, 1.0);
				float fresnel = pow(1.0 - facing, 2.6);
				gl_FragColor = vec4(uRim * 1.35, clamp(fresnel * uStrength, 0.0, 1.0));
				${outputChunks}
			}
		`,
		side: FrontSide,
		transparent: true,
		depthWrite: false,
	})
}

/** Only the reflections: black diffuse, added over the glow. `lite` drops
 *  the clear coat, the costliest shader in the scene, for software
 *  renderers. */
export function createGlassShellMaterial(lite: boolean) {
	const options = {
		color: 0x000000,
		roughness: 0.06,
		metalness: 0,
		transparent: true,
		opacity: 0.55,
		blending: AdditiveBlending,
		depthWrite: false,
	}
	return lite
		? new MeshStandardMaterial({ ...options, envMapIntensity: 2.4 })
		: new MeshPhysicalMaterial({
				...options,
				clearcoat: 1,
				clearcoatRoughness: 0.04,
				envMapIntensity: 1.5,
			})
}

/** Soft-touch charcoal of the cap, handle, and base. */
export function createMetalMaterial(lite: boolean) {
	const options = {
		color: new Color(0.058, 0.055, 0.056),
		roughness: 0.34,
		metalness: 0.3,
		envMapIntensity: 1.15,
	}
	return lite
		? new MeshStandardMaterial({ ...options, roughness: 0.26 })
		: new MeshPhysicalMaterial({
				...options,
				clearcoat: 0.75,
				clearcoatRoughness: 0.18,
			})
}

/** Where the glass meets the cap and the base, and the lid vents. */
export function createLitEdgeMaterial() {
	return new MeshBasicMaterial({
		color: lanternAmber.hot.clone().multiplyScalar(2.4),
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
 * The inside of an orb: its primitive color, deeper toward the edge, with
 * star specks that twinkle and roll with the orb.
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
				vec3 color = uColor * mix(0.34, 1.0, pow(facing, 1.4));
				color += uColor * smoothstep(0.55, 1.0, facing) * 0.35;

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

/** The glossy outside of an orb: a bright rim, a studio highlight, and a
 *  window reflection, clear in the middle so the glyph shows through. */
export function createOrbShellMaterial() {
	return new ShaderMaterial({
		uniforms: {
			uRim: { value: new Color(1, 1, 1) },
			uLit: { value: 0 },
			uDim: { value: 0 },
		},
		vertexShader: worldVertex,
		fragmentShader: /* glsl */ `
			uniform vec3 uRim;
			uniform float uLit;
			uniform float uDim;
			varying vec3 vWorldPosition;
			varying vec3 vWorldNormal;
			varying vec3 vLocalPosition;

			void main() {
				vec3 view = normalize(cameraPosition - vWorldPosition);
				vec3 normal = normalize(vWorldNormal);
				float facing = clamp(dot(normal, view), 0.0, 1.0);
				float rim = pow(1.0 - facing, 2.3);
				vec3 light = normalize(vec3(-0.5, 0.78, 0.6));
				float highlight = pow(clamp(dot(normal, normalize(light + view)), 0.0, 1.0), 90.0);
				float window = smoothstep(0.86, 0.95, dot(normal, light))
					* (1.0 - smoothstep(0.965, 0.99, dot(normal, light)) * 0.55);
				float lit = 1.0 + uLit * 0.9;
				float dim = mix(1.0, 0.45, uDim);
				vec3 color = (uRim * rim * 1.5 * lit + vec3(highlight * 2.2 + window * 0.9)) * dim;
				float alpha = rim * 0.92 + highlight * 0.6 + window * 0.42 + 0.05;
				gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
				${outputChunks}
			}
		`,
		transparent: true,
		depthWrite: false,
	})
}

export function createGlyphMaterial() {
	return new MeshStandardMaterial({
		color: 0xffffff,
		emissive: 0xffffff,
		emissiveIntensity: 1.15,
		roughness: 0.32,
		metalness: 0,
		envMapIntensity: 0.5,
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

/** Sparkles inside the glass. They ride the fluid's swirl angle; the big
 *  ones flare into four-point stars like the still. */
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
				float radius = length(p.xz);
				float angle = uSwirl * (1.15 - 0.35 * radius) + uTime * (0.03 + aSeed * 0.04);
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
