import {
	AdditiveBlending,
	BackSide,
	Color,
	CustomBlending,
	DataTexture,
	FrontSide,
	LinearFilter,
	LinearMipmapLinearFilter,
	MeshBasicMaterial,
	MeshStandardMaterial,
	NormalBlending,
	OneFactor,
	OneMinusSrcAlphaFactor,
	RepeatWrapping,
	RGBAFormat,
	ShaderMaterial,
	SpriteMaterial,
	UnsignedByteType,
	type Texture,
} from 'three'

/**
 * Materials for the 3D lantern. The glass holds Kody's lantern light: the
 * far wall glows brightest where your line of sight passes nearest the
 * heart of the globe and deepens to amber toward the glass, light ripples
 * over the floor, and the outside adds crisp edges and the studio's
 * windows on top. The metal is brushed dark bronze with brass bevels.
 * Each orb is a marble in three layers: a colored core seen from inside,
 * the glyph, and a glossy shell.
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

/** Linear sRGB. The heart of the globe is Kody's lantern glow
 *  (oklch(0.88 0.11 85)) run a little paler, deepening through gold to
 *  amber at the glass, as in the still. */
export const lanternAmber = {
	deep: new Color(0.23, 0.072, 0.004),
	bright: new Color(0.66, 0.3, 0.03),
	heart: new Color(0.99, 0.79, 0.38),
	hot: new Color(1, 0.64, 0.17),
	floor: new Color(1, 0.72, 0.24),
	rim: new Color(0.98, 0.7, 0.28),
	spark: new Color(1, 0.8, 0.4),
	/** What the lantern throws on the page around it. */
	glow: new Color(0.95, 0.6, 0.14),
} as const

/** Linear sRGB for the frame: dark bronze, brushed, with brass where an
 *  edge is turned. */
export const lanternMetal = {
	bronze: new Color(0.05, 0.032, 0.02),
	brass: new Color(0.56, 0.34, 0.1),
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

const glassInteriorVertex = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec3 vLocalPosition;
varying vec3 vHeart;

void main() {
	vec4 world = modelMatrix * vec4(position, 1.0);
	vWorldPosition = world.xyz;
	vWorldNormal = normalize(mat3(modelMatrix) * normal);
	vLocalPosition = position;
	vHeart = (modelMatrix * vec4(0.0, 0.05, 0.0, 1.0)).xyz;
	gl_Position = projectionMatrix * viewMatrix * world;
}
`

/** The far wall of the glass, seen from inside. Every line of sight runs
 *  through the whole globe, so how near it passes the heart sets how much
 *  light it gathers. It writes depth so motes that drift behind the
 *  lantern stay hidden. */
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
		vertexShader: glassInteriorVertex,
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
			varying vec3 vHeart;
			${causticChunk}

			void main() {
				vec3 view = normalize(cameraPosition - vWorldPosition);
				float facing = clamp(dot(-normalize(vWorldNormal), view), 0.0, 1.0);
				vec3 color = mix(uDeep, uBright, pow(facing, 2.2)) * 0.7;

				vec3 toHeart = vHeart - cameraPosition;
				float miss = length(toHeart - view * dot(toHeart, view));
				float gathered = exp(-miss * miss * 3.6);
				color += uHeart * (gathered * 0.95 + gathered * gathered * 0.3);

				float top = smoothstep(uTop - 0.2, uTop, vLocalPosition.y);
				float bottom = smoothstep(uBottom + 0.32, uBottom, vLocalPosition.y);
				color += uHot * (top * top * 0.5 + bottom * bottom * 0.6);
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

/** The base's top seen through the glass: lit from above, rippling with
 *  caustics, and brightest in a ring where it meets the glass. */
export function createGlassFloorMaterial(radius: number) {
	return new ShaderMaterial({
		uniforms: {
			uFloor: { value: lanternAmber.floor.clone() },
			uHot: { value: lanternAmber.hot.clone() },
			uHeart: { value: lanternAmber.heart.clone() },
			uGlow: { value: 1 },
			uTime: { value: 0 },
			uRadius: { value: radius },
		},
		vertexShader: worldVertex,
		fragmentShader: /* glsl */ `
			uniform vec3 uFloor;
			uniform vec3 uHot;
			uniform vec3 uHeart;
			uniform float uGlow;
			uniform float uTime;
			uniform float uRadius;
			varying vec3 vLocalPosition;
			${causticChunk}

			void main() {
				float reach = length(vLocalPosition.xy) / uRadius;
				float ring = smoothstep(0.62, 0.95, reach);
				float light = caustic(vLocalPosition.xy * 3.4, uTime * 0.3);
				vec3 color = uFloor * (0.7 + 0.2 * reach) + uHot * ring * 0.4
					+ uHeart * light * 0.55;
				gl_FragColor = vec4(color * uGlow, 1.0);
				${outputChunks}
			}
		`,
	})
}

/**
 * The outside of the glass, added over the glow: a crisp bright edge with
 * a warm band inside it where the light inside catches the thick of the
 * wall, and the studio's lights in reflection (tall softboxes behind each
 * shoulder that wrap the sides, a small four-pane window up and to the
 * left, a softbox overhead). They are worked out from the reflected ray,
 * so they stay put while the globe turns, as they would on real glass.
 * Face-on the glass reflects little, so the orbs behind it stay clear.
 * One cheap shader, so the software path draws it too.
 */
export function createGlassShellMaterial() {
	return new ShaderMaterial({
		uniforms: {
			uRim: { value: lanternAmber.rim.clone() },
			uReflect: { value: 1 },
		},
		vertexShader: worldVertex,
		fragmentShader: /* glsl */ `
			uniform vec3 uRim;
			uniform float uReflect;
			varying vec3 vWorldPosition;
			varying vec3 vWorldNormal;
			varying vec3 vLocalPosition;

			/** A soft-edged rectangle of light in direction centre, as seen
			 *  along the reflected ray. Returns how much of it is hit and,
			 *  in out q, where on it (half sizes in tangent units). */
			float panel(vec3 ray, vec3 centre, vec2 halfSize, float soft, out vec2 q) {
				q = vec2(10.0);
				float along = dot(ray, centre);
				if (along <= 0.0) return 0.0;
				vec3 right = normalize(vec3(centre.z, 0.0, -centre.x));
				vec3 up = cross(right, centre);
				vec3 p = ray / along - centre;
				q = vec2(dot(p, right), dot(p, up)) / halfSize;
				vec2 inside = smoothstep(1.0 + soft, 1.0 - soft, abs(q));
				return inside.x * inside.y;
			}

			void main() {
				vec3 view = normalize(cameraPosition - vWorldPosition);
				vec3 normal = normalize(vWorldNormal);
				float facing = clamp(dot(normal, view), 0.0, 1.0);
				vec3 ray = reflect(-view, normal);
				float fresnel = 0.04 + 0.96 * pow(1.0 - facing, 5.0);

				vec2 q;
				float window = panel(ray, normalize(vec3(-0.5, 0.45, 0.74)), vec2(0.17, 0.13), 0.12, q);
				vec2 bars = smoothstep(0.05, 0.1, abs(q));
				window *= bars.x * bars.y;
				float left = panel(ray, normalize(vec3(-0.86, 0.22, -0.46)), vec2(0.16, 0.9), 0.45, q);
				float right = panel(ray, normalize(vec3(0.94, 0.16, -0.3)), vec2(0.07, 0.8), 0.4, q);
				float overhead = panel(ray, normalize(vec3(0.0, 1.0, 0.2)), vec2(0.6, 0.4), 0.5, q);
				vec3 studio = vec3(1.0, 0.97, 0.92)
					* (window * 4.0 + left * 9.0 + right * 8.0 + overhead * 2.0);

				float edge = pow(1.0 - facing, 7.0);
				float band = pow(1.0 - facing, 2.4);
				vec3 color = studio * fresnel * uReflect
					+ vec3(1.0, 0.93, 0.78) * edge * 0.9
					+ uRim * band * 0.42;
				gl_FragColor = vec4(color, 1.0);
				${outputChunks}
			}
		`,
		side: FrontSide,
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
	})
}

/** Fine lines running the way the metal was turned or drawn, for its
 *  roughness (and, on a GPU, its relief). Lathe parts, the handle tube, and
 *  the rings all run their v coordinate across the grain. */
export function createBrushedTexture(): Texture {
	const width = 4
	const height = 256
	const data = new Uint8Array(width * height * 4)
	let state = 2414
	const random = () => {
		state = (state * 16807) % 2147483647
		return state / 2147483647
	}
	for (let y = 0; y < height; y++) {
		const drift = 0.5 + 0.5 * Math.sin(y * 0.11) * Math.sin(y * 0.037 + 1.3)
		const value = Math.round((0.6 + 0.24 * random() + 0.16 * drift) * 255)
		for (let x = 0; x < width; x++) {
			data.fill(value, (y * width + x) * 4, (y * width + x) * 4 + 3)
			data[(y * width + x) * 4 + 3] = 255
		}
	}
	const texture = new DataTexture(
		data,
		width,
		height,
		RGBAFormat,
		UnsignedByteType,
	)
	texture.wrapS = RepeatWrapping
	texture.wrapT = RepeatWrapping
	texture.repeat.set(1, 2)
	texture.magFilter = LinearFilter
	texture.minFilter = LinearMipmapLinearFilter
	texture.generateMipmaps = true
	texture.needsUpdate = true
	return texture
}

/** Brushed dark bronze for the cap, handle, and base. `lite` skips the
 *  relief, which a software renderer pays for on every pixel. */
export function createMetalMaterial(lite: boolean, grain: Texture) {
	return new MeshStandardMaterial({
		color: lanternMetal.bronze.clone(),
		metalness: 0.86,
		roughness: 0.62,
		roughnessMap: grain,
		bumpMap: lite ? null : grain,
		bumpScale: 0.7,
		envMapIntensity: 1.35,
	})
}

/** Polished brass on the turned edges, the hinge pins, and the trims. */
export function createTrimMaterial() {
	return new MeshStandardMaterial({
		color: lanternMetal.brass.clone(),
		metalness: 1,
		roughness: 0.3,
		envMapIntensity: 1.5,
	})
}

/** Where the glass meets the cap and the base. */
export function createLitEdgeMaterial() {
	return new MeshBasicMaterial({
		color: lanternAmber.hot.clone().multiplyScalar(2.4),
	})
}

/** The slots round the cap, lit from inside: hottest at the foot, nearest
 *  the light, through vertex colors. */
export function createVentMaterial() {
	return new MeshBasicMaterial({ vertexColors: true })
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

/** The dark line round a glyph, in a deep shade of its orb's color. */
export function createKeylineMaterial() {
	return new MeshBasicMaterial({ color: 0x000000 })
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
