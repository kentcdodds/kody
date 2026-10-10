import {
	AdditiveBlending,
	BufferGeometry,
	CanvasTexture,
	Float32BufferAttribute,
	HalfFloatType,
	LinearMipmapLinearFilter,
	Mesh,
	PerspectiveCamera,
	PMREMGenerator,
	Scene,
	ShaderMaterial,
	SRGBColorSpace,
	Vector2,
	WebGLRenderer,
	WebGLRenderTarget,
	type Texture,
} from 'three'
import { type LanternFrame } from '#client/routes/landing-lantern-3d-engine.ts'
import {
	createLanternModel,
	createLanternStudio,
} from '#client/routes/landing-lantern-3d-model.ts'
import { lanternViewBasis } from '#client/routes/landing-lantern-3d-motion.ts'
import {
	landingPrimitiveIds,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/**
 * The renderer half of the 3D lantern. `landing-lantern-3d.tsx` imports
 * this module on demand, so three.js stays out of the homepage chunk
 * until the lantern is about to scroll into view.
 *
 * Each frame renders the scene into a multisampled half-float target, so
 * the glow can run past white, blooms what does, and tone maps the result
 * onto a transparent canvas: the page shows round the lantern, and the
 * bloom spills onto it as a warm haze.
 */

const glyphSize = 256
const bloom = {
	levels: 5,
	/** Brightness, in linear light, that starts to bloom. */
	threshold: 1,
	knee: 0.5,
	strength: 0.3,
	/** Weight of each wider level on its way back up. */
	spread: 0.9,
} as const
const maxPixelRatio = 2

let glyphImages: Promise<Record<LandingPrimitiveId, HTMLCanvasElement>> | null =
	null

/** Fetch and rasterize the orb glyphs. Rejects if any glyph cannot load,
 *  so the page keeps the still lantern rather than a blank orb, and the
 *  next mount fetches them again. */
export async function preloadLanternTextures() {
	await loadGlyphs()
}

function loadGlyphs() {
	glyphImages ??= Promise.all(
		landingPrimitiveIds.map(async (id) => [id, await rasterize(id)] as const),
	).then(
		(entries) =>
			Object.fromEntries(entries) as Record<
				LandingPrimitiveId,
				HTMLCanvasElement
			>,
		(error: unknown) => {
			glyphImages = null
			throw error
		},
	)
	return glyphImages
}

function rasterize(id: LandingPrimitiveId) {
	const src = `/images/lantern/kody-primitives-glyph-${id}.svg`
	return new Promise<HTMLCanvasElement>((resolve, reject) => {
		const image = new Image()
		image.onload = () => {
			const canvas = document.createElement('canvas')
			canvas.width = glyphSize
			canvas.height = glyphSize
			const context = canvas.getContext('2d')
			if (!context) {
				reject(new Error('No 2D canvas for the lantern glyphs'))
				return
			}
			context.drawImage(image, 0, 0, glyphSize, glyphSize)
			resolve(canvas)
		}
		image.onerror = () =>
			reject(new Error(`Cannot load the lantern glyph ${src}`))
		image.src = src
	})
}

/** The camera `lanternViewBasis` describes, so the orb buttons the motion
 *  module places land on the orbs this camera draws. */
export function createLanternCamera(aspect: number) {
	const basis = lanternViewBasis()
	const camera = new PerspectiveCamera(
		(2 * Math.atan(1 / (2 * basis.zoom)) * 180) / Math.PI,
		aspect,
		2,
		10,
	)
	camera.position.set(basis.origin.x, basis.origin.y, basis.origin.z)
	camera.lookAt(
		basis.origin.x + basis.forward.x,
		basis.origin.y + basis.forward.y,
		basis.origin.z + basis.forward.z,
	)
	camera.updateMatrixWorld()
	return camera
}

/**
 * Mount the scene on `canvas`. The component turns the lantern and moves
 * the orbs through `draw`, and the page keeps the wheel and the pointer.
 * `onLost` fires once if the GPU context goes away or a shader fails.
 */
export async function mountLanternScene(
	canvas: HTMLCanvasElement,
	onLost: () => void,
) {
	const images = await loadGlyphs()
	// Each step of the build pushes its undo. They run newest first on
	// destroy, or as soon as a step throws, so a mount that fails partway
	// still lets go of the GPU context.
	const undo: Array<() => void> = []
	const release = () => {
		for (const step of undo.splice(0).reverse()) step()
	}
	try {
		const { draw } = await buildLanternScene(canvas, images, onLost, undo)
		return { draw, destroy: release }
	} catch (error) {
		release()
		throw error
	}
}

/** Build the scene on `canvas`, pushing the undo of each step onto `undo`
 *  as it goes. */
async function buildLanternScene(
	canvas: HTMLCanvasElement,
	images: Record<LandingPrimitiveId, HTMLCanvasElement>,
	onLost: () => void,
	undo: Array<() => void>,
) {
	const own = <Resource extends { dispose(): void }>(resource: Resource) => {
		undo.push(() => resource.dispose())
		return resource
	}
	let lost = false
	const lose = (event?: Event) => {
		event?.preventDefault()
		if (lost) return
		lost = true
		onLost()
	}
	const renderer = new WebGLRenderer({
		canvas,
		alpha: true,
		premultipliedAlpha: true,
		antialias: false,
		depth: false,
		stencil: false,
		failIfMajorPerformanceCaveat: true,
	})
	undo.push(() => {
		renderer.dispose()
		renderer.forceContextLoss()
	})
	// Undone before the renderer lets go of the context, so letting it go
	// on purpose is not reported as a loss.
	canvas.addEventListener('webglcontextlost', lose)
	undo.push(() => canvas.removeEventListener('webglcontextlost', lose))
	renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
		console.error(
			'The 3D lantern could not build a shader.',
			gl.getShaderInfoLog(fragment) ||
				gl.getShaderInfoLog(vertex) ||
				gl.getProgramInfoLog(program),
		)
		lose()
	}
	renderer.autoClear = false
	renderer.setClearColor(0x000000, 0)

	const textures = Object.fromEntries(
		landingPrimitiveIds.map((id): [LandingPrimitiveId, Texture] => {
			const texture = own(new CanvasTexture(images[id]))
			texture.colorSpace = SRGBColorSpace
			texture.minFilter = LinearMipmapLinearFilter
			texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy())
			return [id, texture]
		}),
	) as Record<LandingPrimitiveId, Texture>
	const model = own(createLanternModel({ glyphs: textures }))
	const scene = new Scene()
	scene.add(model.lantern, model.lights)
	for (const id of landingPrimitiveIds) scene.add(model.orbs[id].mesh)
	// Building the model and baking the environment are each a long task,
	// and the lantern mounts as it scrolls into view: let a frame paint
	// between them.
	await afterNextPaint()

	const pmrem = new PMREMGenerator(renderer)
	const studio = createLanternStudio()
	const environment = own(pmrem.fromScene(studio.scene, 0.02))
	studio.dispose()
	pmrem.dispose()
	scene.environment = environment.texture

	const camera = createLanternCamera(1)

	const sceneTarget = own(
		new WebGLRenderTarget(1, 1, {
			type: HalfFloatType,
			samples: multisamples(renderer),
			depthBuffer: true,
			stencilBuffer: false,
			// No pass reads depth back, so the multisample resolve copies
			// only the color.
			resolveDepthBuffer: false,
		}),
	)
	const levels = Array.from({ length: bloom.levels }, () =>
		own(
			new WebGLRenderTarget(1, 1, {
				type: HalfFloatType,
				depthBuffer: false,
			}),
		),
	)
	const passes = own(createPasses())
	const triangle = own(new BufferGeometry())
	triangle.setAttribute(
		'position',
		new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
	)
	const screen = new Mesh(triangle, passes.final)
	screen.frustumCulled = false

	const runPass = (
		material: ShaderMaterial,
		target: WebGLRenderTarget | null,
	) => {
		screen.material = material
		renderer.setRenderTarget(target)
		renderer.render(screen, camera)
	}

	let cssWidth = canvas.clientWidth
	let cssHeight = canvas.clientHeight
	let fittedWidth = 0
	let fittedHeight = 0
	const resize = new ResizeObserver(([entry]) => {
		if (!entry) return
		cssWidth = entry.contentRect.width
		cssHeight = entry.contentRect.height
	})
	resize.observe(canvas)
	undo.push(() => resize.disconnect())

	const fit = () => {
		const ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio)
		const width = Math.max(1, Math.round(cssWidth * ratio))
		const height = Math.max(1, Math.round(cssHeight * ratio))
		if (width === fittedWidth && height === fittedHeight) return
		fittedWidth = width
		fittedHeight = height
		renderer.setPixelRatio(1)
		renderer.setSize(width, height, false)
		camera.aspect = width / height
		camera.updateProjectionMatrix()
		sceneTarget.setSize(width, height)
		let levelWidth = width
		let levelHeight = height
		for (const level of levels) {
			levelWidth = Math.max(1, Math.round(levelWidth / 2))
			levelHeight = Math.max(1, Math.round(levelHeight / 2))
			level.setSize(levelWidth, levelHeight)
		}
	}

	/** Point a bloom pass at the target it reads. */
	const readFrom = (material: ShaderMaterial, source: WebGLRenderTarget) => {
		material.uniforms.source!.value = source.texture
		const texel: Vector2 = material.uniforms.texel!.value
		texel.set(1 / source.width, 1 / source.height)
	}

	fit()
	// Compiled for the target the scene renders into, so the first frame
	// does not compile again for different output settings.
	renderer.setRenderTarget(sceneTarget)
	await renderer.compileAsync(scene, camera)
	renderer.setRenderTarget(null)

	return {
		draw(frame: LanternFrame) {
			if (lost) return
			fit()
			model.lantern.rotation.y = frame.yaw
			model.uniforms.time.value = frame.time
			model.uniforms.light.value = frame.light
			model.uniforms.sparkle.value = frame.sparkle
			for (const orb of frame.orbs) {
				const { mesh, glow } = model.orbs[orb.id]
				mesh.position.set(orb.position.x, orb.position.y, orb.position.z)
				mesh.scale.setScalar(orb.scale)
				mesh.lookAt(camera.position)
				glow.value = orb.glow
			}
			renderer.setRenderTarget(sceneTarget)
			renderer.clear()
			renderer.render(scene, camera)

			readFrom(passes.prefilter, sceneTarget)
			runPass(passes.prefilter, levels[0]!)
			for (let index = 1; index < levels.length; index++) {
				readFrom(passes.down, levels[index - 1]!)
				runPass(passes.down, levels[index]!)
			}
			for (let index = levels.length - 2; index >= 0; index--) {
				readFrom(passes.up, levels[index + 1]!)
				runPass(passes.up, levels[index]!)
			}
			passes.final.uniforms.scene!.value = sceneTarget.texture
			passes.final.uniforms.bloom!.value = levels[0]!.texture
			renderer.setRenderTarget(null)
			renderer.clear()
			runPass(passes.final, null)
		},
	}
}

function afterNextPaint() {
	return new Promise<void>((resolve) => {
		requestAnimationFrame(() => setTimeout(resolve, 0))
	})
}

/** Up to 4x multisampling, as far as this GPU can for half-float color. */
function multisamples(renderer: WebGLRenderer) {
	const gl = renderer.getContext()
	if (!(gl instanceof WebGL2RenderingContext)) return 0
	const counts = gl.getInternalformatParameter(
		gl.RENDERBUFFER,
		gl.RGBA16F,
		gl.SAMPLES,
	) as Int32Array | null
	const best = counts?.[0] ?? 0
	return Math.min(4, best)
}

const passVertex = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vUv = position.xy * 0.5 + 0.5;
		gl_Position = vec4(position.xy, 0.0, 1.0);
	}
`

/**
 * The bloom is a mip chain: the bright part of the frame at half size,
 * halved again level by level, then each level blurred back up onto the
 * one above it, so a glow has a tight core and a wide falloff. The final
 * pass adds it to the frame, tone maps, and premultiplies for the page.
 * The bloom's own alpha is its brightness, so it shows over the page.
 *
 * The tone curve is linear to 0.5, so the hardware and the marbles keep
 * their colors, then rolls each channel off toward 1 on its own: a bright
 * amber runs gold, then yellow, then white, like a flame on film.
 */
function createPasses() {
	const pass = (fragmentShader: string, uniforms: ShaderMaterial['uniforms']) =>
		new ShaderMaterial({
			uniforms,
			vertexShader: passVertex,
			fragmentShader,
			depthTest: false,
			depthWrite: false,
		})
	const prefilter = pass(
		/* glsl */ `
			uniform sampler2D source;
			uniform vec2 texel;
			uniform float threshold;
			uniform float knee;
			varying vec2 vUv;
			void main() {
				vec3 color = (
					texture2D(source, vUv + texel * vec2(-1.0, -1.0)).rgb +
					texture2D(source, vUv + texel * vec2(1.0, -1.0)).rgb +
					texture2D(source, vUv + texel * vec2(-1.0, 1.0)).rgb +
					texture2D(source, vUv + texel * vec2(1.0, 1.0)).rgb) * 0.25;
				float bright = max(color.r, max(color.g, color.b));
				float soft = clamp(bright - threshold + knee, 0.0, 2.0 * knee);
				soft = soft * soft / (4.0 * knee + 0.0001);
				float weight = max(soft, bright - threshold) / max(bright, 0.0001);
				gl_FragColor = vec4(min(color * weight, vec3(24.0)), 1.0);
			}
		`,
		{
			source: { value: null },
			texel: { value: new Vector2() },
			threshold: { value: bloom.threshold },
			knee: { value: bloom.knee },
		},
	)
	const down = pass(
		/* glsl */ `
			uniform sampler2D source;
			uniform vec2 texel;
			varying vec2 vUv;
			void main() {
				vec3 sum = texture2D(source, vUv).rgb * 4.0;
				sum += texture2D(source, vUv - texel).rgb;
				sum += texture2D(source, vUv + texel).rgb;
				sum += texture2D(source, vUv + vec2(texel.x, -texel.y)).rgb;
				sum += texture2D(source, vUv - vec2(texel.x, -texel.y)).rgb;
				gl_FragColor = vec4(sum * 0.125, 1.0);
			}
		`,
		{ source: { value: null }, texel: { value: new Vector2() } },
	)
	const up = pass(
		/* glsl */ `
			uniform sampler2D source;
			uniform vec2 texel;
			uniform float spread;
			varying vec2 vUv;
			void main() {
				vec2 h = texel * 0.5;
				vec3 sum = texture2D(source, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
				sum += texture2D(source, vUv + vec2(-h.x, h.y)).rgb * 2.0;
				sum += texture2D(source, vUv + vec2(0.0, h.y * 2.0)).rgb;
				sum += texture2D(source, vUv + vec2(h.x, h.y)).rgb * 2.0;
				sum += texture2D(source, vUv + vec2(h.x * 2.0, 0.0)).rgb;
				sum += texture2D(source, vUv + vec2(h.x, -h.y)).rgb * 2.0;
				sum += texture2D(source, vUv + vec2(0.0, -h.y * 2.0)).rgb;
				sum += texture2D(source, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
				gl_FragColor = vec4(sum / 12.0 * spread, 1.0);
			}
		`,
		{
			source: { value: null },
			texel: { value: new Vector2() },
			spread: { value: bloom.spread },
		},
	)
	up.blending = AdditiveBlending
	up.transparent = true
	const final = pass(
		/* glsl */ `
			uniform sampler2D scene;
			uniform sampler2D bloom;
			uniform float strength;
			varying vec2 vUv;
			void main() {
				vec4 base = texture2D(scene, vUv);
				vec3 glow = texture2D(bloom, vUv).rgb * strength;
				vec3 color = base.rgb + glow;
				float alpha = clamp(base.a + max(glow.r, max(glow.g, glow.b)), 0.0, 1.0);
				vec3 straight = alpha > 0.0001 ? color / alpha : vec3(0.0);
				vec3 over = max(straight - 0.5, 0.0);
				gl_FragColor = vec4(min(straight, 0.5) + 0.5 * (1.0 - exp(-over * 2.0)), alpha);
				#include <colorspace_fragment>
				float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
				gl_FragColor.rgb += (noise - 0.5) / 255.0;
				gl_FragColor.rgb *= gl_FragColor.a;
			}
		`,
		{
			scene: { value: null },
			bloom: { value: null },
			strength: { value: bloom.strength },
		},
	)
	return {
		prefilter,
		down,
		up,
		final,
		dispose() {
			for (const material of [prefilter, down, up, final]) material.dispose()
		},
	}
}
