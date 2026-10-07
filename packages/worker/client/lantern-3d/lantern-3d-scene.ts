import {
	Color,
	Matrix4,
	MeshStandardMaterial,
	NeutralToneMapping,
	type Object3D,
	PerspectiveCamera,
	PMREMGenerator,
	Plane,
	Quaternion,
	Raycaster,
	Scene,
	SRGBColorSpace,
	Vector2,
	Vector3,
	WebGLRenderer,
} from 'three'
import {
	landingLanternGlass,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'
import { parseCssColor } from './lantern-3d-color.ts'
import {
	constellationArrivals,
	constellationAt,
} from './lantern-3d-constellation.ts'
import {
	lanternCavity,
	lanternOrbHomes,
	lanternOrbRadius,
	lanternStill,
} from './lantern-3d-layout.ts'
import {
	createLanternModel,
	paintLanternOrb,
	type LanternOrbView,
	type LanternStep,
} from './lantern-3d-model.ts'
import {
	clampToCavity,
	createLanternContents,
	createLanternSpin,
	dragLanternSpin,
	lanternFlickVelocity,
	lanternFluidToRoot,
	lanternMaxSpin,
	lanternRootToFluid,
	lanternTiltLimit,
	stepLanternContents,
	stepLanternSpin,
	type LanternContents,
	type LanternOrbHold3d,
	type LanternPointerSample3d,
	type Vec3,
} from './lantern-3d-motion.ts'
import {
	type LanternBox,
	type LanternMotion,
	type LanternPalette,
	type LanternPoint,
	type LanternSceneFrame,
	type LanternViewport,
} from './lantern-3d-protocol.ts'
import {
	createLanternQuality,
	lanternTrialSpeed,
	resizeLanternQuality,
	stepLanternQuality,
	type LanternQuality,
} from './lantern-3d-quality.ts'
import { createLanternStudio } from './lantern-3d-studio.ts'

/**
 * The live 3D lantern: renderer, camera, and frame loop. It runs in a
 * worker on a canvas the page handed over, so it never touches the DOM:
 * the page sends sizes, colors, and pointer positions in canvas pixels.
 * The camera is fitted so the lantern lands on the 2D still's box (the
 * frame), whatever size the canvas bleeds to. Each frame reports where the
 * orbs project so the page can keep its hotspots and leader lines on them.
 *
 * Startup goes through `step`, one small piece at a time, so the worker
 * can stop between pieces while the page navigates.
 *
 * Reduced motion keeps the scene still: no wander, twinkle, fireflies,
 * coasting, or idle constellation, and frames draw only when something
 * changes. Pointer turns and drags still respond directly.
 *
 * The first second of frames is a trial (`trial`): a device that cannot
 * draw them fast enough keeps the 2D lantern.
 */

export type LanternSceneOptions = {
	canvas: OffscreenCanvas
	viewport: LanternViewport
	palette: LanternPalette
	motion: LanternMotion
	/** The 2D orbs, in frame pixels: the first frame draws them there. */
	orbs: ReadonlyArray<LanternPoint>
	step: LanternStep
	onFrame: (frame: LanternSceneFrame) => void
	onLost: () => void
}

export type LanternScene = {
	frame: () => LanternSceneFrame
	layout: (viewport: LanternViewport) => void
	/** Moves the orbs onto the 2D ones and draws at once. */
	matchPoster: (orbs: ReadonlyArray<LanternPoint>) => LanternSceneFrame
	setActive: (id: LandingPrimitiveId | null) => void
	setPalette: (palette: LanternPalette) => void
	setMotion: (motion: LanternMotion) => void
	setVisible: (visible: boolean) => void
	celebrate: (id: LandingPrimitiveId) => void
	/** A tap on the lantern itself. */
	nudge: () => void
	/** Keyboard and button turns: -1 or 1, with a flourish for `big`. */
	spin: (direction: number, big: boolean) => void
	beginTurn: (x: number, y: number, t: number) => void
	turn: (x: number, y: number, t: number) => void
	endTurn: (flick: boolean, t: number) => void
	grabOrb: (id: LandingPrimitiveId, x: number, y: number, t: number) => void
	moveOrb: (x: number, y: number, t: number) => void
	releaseOrb: (flick: boolean, t: number) => void
	look: (x: number, y: number) => void
	stopLooking: () => void
	/** Times the first second of frames drawn one after another, whenever
	 *  the scene is visible: `slow` when they ran too slow to show.
	 *  Reduced motion draws only on change, so it passes at once. */
	trial: () => Promise<'fast' | 'slow'>
	dispose: () => void
}

const fov = 24

/** Device pixels the canvas may draw, so a big screen cannot ask for 4K. */
const maxPixels = 2_600_000

/** Texels along each cube face of the studio's environment map. */
const environmentSize = 256

/** Drag across the whole lantern turns it this far, radians. */
const turnPerWidth = 2.8
const tiltPerHeight = 1.4

/** How far the open orb comes toward you, along its line of sight so it
 *  stays under the pointer that opened it. */
const lureDepth = 0.5

/** The dark theme lifts the primitive colors so words read on a dark page.
 *  The orbs glow in the same amber glass either way, and their white glyphs
 *  need the deeper tones: scaling linear RGB by this scales OKLab lightness
 *  by about 0.86, back near the light theme's. */
const darkOrbDepth = 0.63

type OrbEffects = {
	lit: number
	dim: number
	pop: number
	spunAt: number | null
	lookYaw: number
	lookPitch: number
}

export async function createLanternScene(
	options: LanternSceneOptions,
): Promise<LanternScene> {
	const { canvas, step } = options
	const renderer = await step(() => {
		const created = new WebGLRenderer({
			canvas,
			alpha: true,
			antialias: true,
			powerPreference: 'default',
			failIfMajorPerformanceCaveat: true,
		})
		created.setClearColor(0x000000, 0)
		created.outputColorSpace = SRGBColorSpace
		created.toneMapping = NeutralToneMapping
		created.toneMappingExposure = 1
		return created
	})

	const scene = new Scene()
	const camera = new PerspectiveCamera(fov, 1, 1, 30)
	const model = await createLanternModel({ step })
	scene.add(model.root, model.ground)

	const environment = await step(() => {
		const pmrem = new PMREMGenerator(renderer)
		const studio = createLanternStudio()
		const texture = pmrem.fromScene(studio.scene, 0, 0.1, 100, {
			size: environmentSize,
		}).texture
		studio.dispose()
		pmrem.dispose()
		return texture
	})
	model.root.traverse((object) => {
		if (!('material' in object)) return
		const material = object.material
		if (material instanceof MeshStandardMaterial) {
			material.envMap = environment
			material.needsUpdate = true
		}
	})

	let contents: LanternContents = createLanternContents(lanternOrbHomes)
	let spin = createLanternSpin()
	let motion = options.motion
	let viewport = options.viewport
	let time = 0
	let visible = false
	let disposed = false
	let lost = false
	/** No frames until the first one has drawn. */
	let started = false
	let activeId: LandingPrimitiveId | null = null
	let lureAt: Vec3 | null = null
	let excitement = 0
	/** When the visitor last did something, on the scene clock. */
	let quietFrom = 0
	/** How far the constellation's light had run last frame. */
	let threadHead: number | null = null
	let quality: LanternQuality = createLanternQuality({
		devicePixelRatio: viewport.devicePixelRatio,
		cssPixels: 1,
		maxPixels,
	})
	/** The trial's frame times so far, and who waits on its verdict. */
	let trial: {
		stamps: Array<number>
		done: (speed: 'fast' | 'slow') => void
	} | null = null

	let hold: {
		id: LandingPrimitiveId
		z: number
		offset: { x: number; y: number }
		samples: Array<LanternPointerSample3d>
		pose: LanternOrbHold3d | null
	} | null = null
	let turning: {
		lastX: number
		lastY: number
		yaw: number
		tilt: number
		samples: Array<LanternPointerSample3d>
	} | null = null
	let pointer: { x: number; y: number } | null = null
	const look = { yaw: 0, tilt: 0 }

	const effects = new Map<LandingPrimitiveId, OrbEffects>(
		model.orbs.map((orb) => [
			orb.id,
			{
				lit: 0,
				dim: 0,
				pop: 0,
				spunAt: null,
				lookYaw: 0,
				lookPitch: 0,
			},
		]),
	)
	const colors = new Map<LandingPrimitiveId, Color>()

	const size = { width: 0, height: 0 }
	let frameBox: LanternBox = { left: 0, top: 0, width: 0, height: 0 }
	let focal = 1
	let lastReport: LanternSceneFrame = { orbs: [], width: 0, height: 0 }

	const raycaster = new Raycaster()
	const pointerNdc = new Vector2()
	const rootInverse = new Matrix4()
	const plane = new Plane()
	const hit = new Vector3()
	const world = new Vector3()
	const inView = new Vector3()
	const projected = new Vector3()
	const axis = new Vector3()
	const turnStep = new Quaternion()
	const bufferSize = new Vector2()

	const requestFrame = frameClock()
	/** Cancels the frame on order, if one is. */
	let cancelFrame: (() => void) | null = null
	let last = performance.now()
	let lastFrameAt: number | null = null

	function wanderAmount() {
		return motion.reduced ? 0 : motion.wander
	}

	function displayTilt() {
		return Math.min(
			Math.max(spin.tilt + look.tilt, lanternTiltLimit.min),
			lanternTiltLimit.max,
		)
	}

	function applySize() {
		renderer.setPixelRatio(quality.pixelRatio)
		renderer.setSize(size.width, size.height, false)
		renderer.getDrawingBufferSize(bufferSize)
		const scale = bufferSize.y / (2 * Math.tan((fov * Math.PI) / 360))
		model.sparkles.uniforms.uScale!.value = scale
		model.fireflies.uniforms.uScale!.value = scale
		model.burst.points.material.uniforms.uScale!.value = scale
		model.thread.points.material.uniforms.uScale!.value = scale
	}

	function layout(next: LanternViewport) {
		viewport = next
		if (disposed || next.width === 0 || next.frame.width === 0) return
		size.width = next.width
		size.height = next.height
		frameBox = next.frame
		const unit = frameBox.width / lanternStill.width
		const distance = size.height / (2 * unit * Math.tan((fov * Math.PI) / 360))
		const glassX = frameBox.left + frameBox.width * landingLanternGlass.x
		const glassY = frameBox.top + frameBox.height * landingLanternGlass.y
		camera.position.set(
			-(glassX - size.width / 2) / unit,
			(glassY - size.height / 2) / unit,
			distance,
		)
		camera.aspect = size.width / size.height
		camera.near = Math.max(distance - 6, 0.5)
		camera.far = distance + 6
		camera.updateProjectionMatrix()
		camera.updateMatrixWorld()
		focal = size.height / (2 * Math.tan((fov * Math.PI) / 360))
		quality = resizeLanternQuality(quality, {
			devicePixelRatio: next.devicePixelRatio,
			cssPixels: size.width * size.height,
			maxPixels,
		})
		applySize()
		wake()
	}

	function setPalette(palette: LanternPalette) {
		for (const orb of model.orbs) {
			const rgb = parseCssColor(palette.colors[orb.id])
			const color = rgb ? new Color(...rgb) : new Color(1, 0.6, 0.2)
			if (palette.dark) color.multiplyScalar(darkOrbDepth)
			colors.set(orb.id, color)
			paintLanternOrb(orb, color)
		}
		model.thread.paint(
			model.orbs.map((orb) => colors.get(orb.id) ?? new Color(1, 1, 1)),
		)
		model.aura.opacity = palette.dark ? 0.5 : 0.32
		model.pool.opacity = palette.dark ? 0.55 : 0.38
		model.shadow.opacity = palette.dark ? 0.5 : 0.26
		model.fireflies.uniforms.uOpacity!.value = palette.dark ? 1 : 0.9
		wake()
	}

	function orbState(id: LandingPrimitiveId) {
		return contents.orbs.find((orb) => orb.id === id) ?? null
	}

	/** The lantern's idle sway, radians. The fluid sways with it. */
	function sway() {
		return motion.reduced ? 0 : Math.sin(time * 0.31) * 0.07
	}

	/** An orb's centre in root space: the fluid's frame turned and tipped
	 *  the way the glass is. */
	function orbRoot(id: LandingPrimitiveId): Vec3 | null {
		const orb = orbState(id)
		if (!orb) return null
		return lanternFluidToRoot(orb, contents.swirlAngle, displayTilt())
	}

	function lure() {
		if (!activeId || !lureAt || hold || motion.reduced) return null
		return { id: activeId, ...lureAt }
	}

	/** Toward the camera from where the orb is now, stopping short of the
	 *  glass. Moving along the view ray keeps it under the pointer, so a
	 *  hover cannot pull the orb out from under itself and close again. */
	function lureToward(id: LandingPrimitiveId): Vec3 | null {
		const orb = orbRoot(id)
		if (!orb) return null
		model.root.updateMatrixWorld()
		rootInverse.copy(model.root.matrixWorld).invert()
		axis.copy(camera.position).applyMatrix4(rootInverse)
		axis.set(axis.x - orb.x, axis.y - orb.y, axis.z - orb.z).normalize()
		const limit = lanternCavity.radius - lanternOrbRadius - 0.03
		const along = orb.x * axis.x + orb.y * axis.y + orb.z * axis.z
		const room =
			along * along - (orb.x ** 2 + orb.y ** 2 + orb.z ** 2) + limit ** 2
		const travel =
			room > 0 ? Math.min(lureDepth, Math.max(0, Math.sqrt(room) - along)) : 0
		return {
			x: orb.x + axis.x * travel,
			y: orb.y + axis.y * travel,
			z: orb.z + axis.z * travel,
		}
	}

	/** A point under canvas pixel (x, y) on the plane z = `depth` in root
	 *  space. */
	function rootPoint(x: number, y: number, depth: number) {
		if (size.width === 0 || size.height === 0) return null
		pointerNdc.set((x / size.width) * 2 - 1, -((y / size.height) * 2 - 1))
		camera.updateMatrixWorld()
		model.root.updateMatrixWorld()
		raycaster.setFromCamera(pointerNdc, camera)
		rootInverse.copy(model.root.matrixWorld).invert()
		const ray = raycaster.ray.clone().applyMatrix4(rootInverse)
		plane.set(new Vector3(0, 0, 1), -depth)
		return ray.intersectPlane(plane, hit)
	}

	function placeOrbs(points: ReadonlyArray<LanternPoint>) {
		if (frameBox.width === 0) return
		const angle = contents.swirlAngle
		const tilt = displayTilt()
		contents = {
			...contents,
			orbs: contents.orbs.map((orb) => {
				const point = points.find((entry) => entry.id === orb.id)
				if (!point) return orb
				const at = rootPoint(
					frameBox.left + point.x,
					frameBox.top + point.y,
					lanternFluidToRoot(orb.home, angle, tilt).z,
				)
				if (!at) return orb
				return {
					...orb,
					...clampToCavity(lanternRootToFluid(at, angle, tilt), orb.radius),
					vx: 0,
					vy: 0,
					vz: 0,
				}
			}),
		}
	}

	function advance(dt: number) {
		const animate = !motion.reduced
		if (animate) time += dt

		if (turning) {
			spin = dragLanternSpin(spin, { yaw: turning.yaw, tilt: turning.tilt }, dt)
			turning.yaw = 0
			turning.tilt = 0
			if (animate)
				spin = stepLanternSpin(spin, dt, { held: true, settle: false })
		} else if (animate) {
			spin = stepLanternSpin(spin, dt, { held: false, settle: true })
		}

		const lookTarget = lookToward()
		const ease = animate ? 1 - Math.exp(-3.2 * dt) : 1
		look.yaw += (lookTarget.yaw - look.yaw) * ease
		look.tilt += (lookTarget.tilt - look.tilt) * ease

		const before = contents.orbs.map((orb) => ({
			id: orb.id,
			vx: orb.vx,
			vy: orb.vy,
			vz: orb.vz,
			coasting: orb.coasting,
		}))
		contents = stepLanternContents(contents, animate || hold ? dt : 0, {
			time,
			amplitude: wanderAmount(),
			yaw: spin.yaw + sway(),
			tilt: displayTilt(),
			rigid: !animate,
			hold: hold?.pose ?? null,
			lure: lure(),
		})
		if (animate) sparkOnImpact(before)

		excitement = Math.max(
			excitement * Math.exp(-1.6 * dt),
			Math.min(Math.abs(contents.swirl) * 0.035, 0.32),
		)
	}

	/** A hard bounce off the glass or a neighbour throws a few sparks. */
	function sparkOnImpact(
		before: ReadonlyArray<{
			id: LandingPrimitiveId
			vx: number
			vy: number
			vz: number
			coasting: boolean
		}>,
	) {
		for (const previous of before) {
			if (!previous.coasting || previous.id === hold?.id) continue
			const speed = Math.hypot(previous.vx, previous.vy, previous.vz)
			if (speed < 1.3) continue
			const orb = orbState(previous.id)
			const at = orbRoot(previous.id)
			if (!orb || !at) continue
			const turn =
				previous.vx * orb.vx + previous.vy * orb.vy + previous.vz * orb.vz
			if (turn > 0) continue
			model.burst.emit(
				new Vector3(at.x, at.y, at.z),
				colors.get(orb.id) ?? new Color(1, 0.7, 0.3),
				{ count: 10, speed: 0.55, time },
			)
			excitement = Math.min(excitement + 0.12, 0.45)
		}
	}

	function lookToward() {
		if (!pointer || motion.reduced || turning || hold) {
			return { yaw: 0, tilt: 0 }
		}
		const glassX = frameBox.left + frameBox.width * landingLanternGlass.x
		const glassY = frameBox.top + frameBox.height * landingLanternGlass.y
		const nx = (pointer.x - glassX) / Math.max(frameBox.width, 1)
		const ny = (pointer.y - glassY) / Math.max(frameBox.height, 1)
		const reach = Math.hypot(nx, ny)
		// Only nearby pointers draw the lantern's eye.
		const pull = Math.max(0, 1 - Math.max(reach - 0.8, 0) / 1.4)
		return {
			yaw: Math.max(-1, Math.min(1, nx)) * 0.24 * pull,
			tilt: Math.max(-1, Math.min(1, ny)) * 0.1 * pull,
		}
	}

	function paint(dt: number) {
		const animate = !motion.reduced
		const settle = animate ? 1 - Math.exp(-10 * dt) : 1
		model.root.position.y = animate ? Math.sin(time * 0.8) * 0.018 : 0
		const tilt = displayTilt()
		model.lantern.rotation.set(tilt, spin.yaw + look.yaw + sway(), 0)
		model.fluid.rotation.x = tilt
		model.handle.rotation.x =
			spin.swing + (animate ? Math.sin(time * 0.9 + 0.4) * 0.03 : 0)

		const glow =
			1 + (animate ? Math.sin(time * 1.6) * 0.035 : 0) + excitement * 0.6
		model.glassInterior.uniforms.uGlow!.value = glow
		model.glassInterior.uniforms.uTime!.value = time
		model.glassFloor.uniforms.uGlow!.value = glow
		model.glassFloor.uniforms.uTime!.value = time
		model.innerLight.intensity = 7 * glow
		model.sparkles.uniforms.uSwirl!.value = contents.swirlAngle
		model.sparkles.uniforms.uTime!.value = time
		model.sparkles.uniforms.uGlow!.value = 1 + excitement
		model.fireflies.uniforms.uTime!.value = time
		model.burst.points.material.uniforms.uTime!.value = time

		for (const orb of model.orbs) paintOrb(orb, dt, settle, animate)
		paintThread()
	}

	/** The idle constellation, shown only while the visitor just watches. */
	function paintThread() {
		const moment =
			motion.reduced || activeId || hold || turning
				? null
				: constellationAt(time - quietFrom, model.orbs.length - 1)
		model.thread.points.visible = moment !== null
		if (!moment) {
			threadHead = null
			return
		}
		model.thread.place(
			model.orbs.flatMap((view) => {
				const at = orbRoot(view.id)
				if (!at) return []
				return [{ ...at, radius: lanternOrbRadius * view.group.scale.x }]
			}),
		)
		const uniforms = model.thread.points.material.uniforms
		uniforms.uHead!.value = moment.head
		uniforms.uSettle!.value = moment.settle
		uniforms.uGlow!.value = moment.glow
		for (const stop of constellationArrivals(threadHead, moment.head)) {
			const view = model.orbs[stop]
			const fx = view ? effects.get(view.id) : undefined
			if (fx) fx.pop = Math.max(fx.pop, 0.45)
			if (stop === model.orbs.length - 1) {
				excitement = Math.min(excitement + 0.2, 0.45)
			}
		}
		threadHead = moment.head
	}

	/** The visitor did something: the idle moment waits for quiet again. */
	function stir() {
		quietFrom = time
	}

	function paintOrb(
		view: LanternOrbView,
		dt: number,
		settle: number,
		animate: boolean,
	) {
		const state = orbState(view.id)
		const at = orbRoot(view.id)
		const fx = effects.get(view.id)
		if (!state || !at || !fx) return
		view.group.position.set(at.x, at.y, at.z)

		if (animate) {
			const speed = Math.hypot(state.vx, state.vy)
			if (speed > 1e-4) {
				axis.set(-state.vy, state.vx, 0).normalize()
				turnStep.setFromAxisAngle(axis, (speed * dt) / lanternOrbRadius)
				view.roll.quaternion.premultiply(turnStep)
			}
			if (Math.abs(contents.swirl) > 1e-3) {
				axis.set(0, 1, 0)
				turnStep.setFromAxisAngle(axis, contents.swirl * dt)
				view.roll.quaternion.premultiply(turnStep)
			}
		}

		const lit = activeId === view.id ? 1 : 0
		const dim = activeId && activeId !== view.id ? 1 : 0
		fx.lit += (lit - fx.lit) * settle
		fx.dim += (dim - fx.dim) * settle
		fx.pop *= animate ? Math.exp(-3.5 * dt) : 0

		let spun = 0
		if (fx.spunAt !== null) {
			const t = (time - fx.spunAt) / 0.9
			if (t >= 1) fx.spunAt = null
			else spun = Math.PI * 2 * (1 - (1 - t) ** 3)
		}

		let yaw = 0
		let pitch = 0
		if (animate && pointer) {
			view.group.getWorldPosition(world)
			projected.copy(world).project(camera)
			const px = ((projected.x + 1) / 2) * size.width
			const py = ((1 - projected.y) / 2) * size.height
			yaw = Math.max(-1, Math.min(1, (pointer.x - px) / 260)) * 0.55
			pitch = Math.max(-1, Math.min(1, (pointer.y - py) / 260)) * 0.45
		}
		if (animate) {
			yaw += Math.max(-0.5, Math.min(0.5, state.vx * 0.3))
			pitch -= Math.max(-0.5, Math.min(0.5, state.vy * 0.3))
		}
		const follow = animate ? 1 - Math.exp(-6 * dt) : 1
		fx.lookYaw += (yaw - fx.lookYaw) * follow
		fx.lookPitch += (pitch - fx.lookPitch) * follow
		view.glyph.rotation.set(fx.lookPitch, fx.lookYaw + spun, 0)

		const scale = 1 + fx.lit * 0.1 + fx.pop * 0.22
		view.group.scale.setScalar(scale)
		view.core.uniforms.uLit!.value = fx.lit
		view.core.uniforms.uDim!.value = fx.dim
		view.core.uniforms.uTime!.value = time
		view.shell.uniforms.uLit!.value = fx.lit
		view.shell.uniforms.uDim!.value = fx.dim
		view.glyphMaterial.emissiveIntensity =
			(1.15 + fx.lit * 0.55 + fx.pop * 0.8) * (1 - fx.dim * 0.5)
		view.halo.opacity =
			(0.5 + fx.lit * 0.45 + fx.pop * 0.4) * (1 - fx.dim * 0.6)
	}

	function project(): LanternSceneFrame {
		const orbs = model.orbs.map((view) => {
			view.group.getWorldPosition(world)
			inView.copy(world).applyMatrix4(camera.matrixWorldInverse)
			const depth = Math.max(-inView.z, 0.1)
			projected.copy(world).project(camera)
			return {
				id: view.id,
				x: ((projected.x + 1) / 2) * size.width - frameBox.left,
				y: ((1 - projected.y) / 2) * size.height - frameBox.top,
				radius: (lanternOrbRadius * view.group.scale.x * focal) / depth,
				depth,
			}
		})
		const byDepth = [...orbs].sort((a, b) => b.depth - a.depth)
		return {
			orbs: orbs.map((orb) => ({
				id: orb.id,
				x: orb.x,
				y: orb.y,
				radius: orb.radius,
				order: byDepth.indexOf(orb) + 1,
			})),
			width: frameBox.width,
			height: frameBox.height,
		}
	}

	function report() {
		if (frameBox.width === 0) return
		const next = project()
		if (sameFrame(lastReport, next)) return
		lastReport = next
		options.onFrame(next)
	}

	function draw(dt: number) {
		advance(dt)
		paint(dt)
		renderer.render(scene, camera)
		report()
	}

	function busy() {
		if (hold || turning) return true
		return !motion.reduced
	}

	function tick(now: number) {
		cancelFrame = null
		if (disposed || lost) return
		const dt = Math.min(Math.max((now - last) / 1000, 0), 1 / 30)
		if (lastFrameAt !== null && !motion.reduced) {
			const next = stepLanternQuality(quality, now - lastFrameAt)
			if (next.pixelRatio !== quality.pixelRatio) {
				quality = next
				applySize()
			} else {
				quality = next
			}
		}
		last = now
		draw(dt)
		timeTrial(now)
		const keepGoing = visible && busy()
		lastFrameAt = keepGoing ? now : null
		if (keepGoing) cancelFrame = requestFrame(tick)
	}

	/** Only frames drawn one after another count, so a pause starts over. */
	function timeTrial(now: number) {
		if (!trial) return
		if (lastFrameAt === null) trial.stamps = []
		trial.stamps.push(now)
		const speed = lanternTrialSpeed(trial.stamps)
		if (speed) endTrial(speed)
	}

	function endTrial(speed: 'fast' | 'slow') {
		const done = trial?.done
		trial = null
		done?.(speed)
	}

	function wake() {
		if (disposed || lost || !started || !visible || cancelFrame) return
		last = performance.now()
		lastFrameAt = null
		cancelFrame = requestFrame(tick)
	}

	const onLost = (event: Event) => {
		event.preventDefault()
		lost = true
		cancelFrame?.()
		cancelFrame = null
		options.onLost()
	}
	canvas.addEventListener('webglcontextlost', onLost)

	setPalette(options.palette)
	layout(viewport)
	placeOrbs(options.orbs)

	// One part of the scene at a time, so no single step holds the GPU (or
	// the CPU standing in for one) for long.
	for (const part of [...model.root.children, model.ground]) {
		await step(() => compile(renderer, part, camera, scene))
	}
	await step(() => {
		advance(0)
		paint(0)
		renderer.render(scene, camera)
	})
	// The canvas shows its first frame as soon as this task ends. Wait for
	// the GPU to finish it so the reveal never waits on a frame in flight.
	await step(() => gpuCaughtUp(renderer.getContext()))
	started = true
	lastReport = project()

	return {
		frame: () => lastReport,
		layout,
		matchPoster(orbs) {
			placeOrbs(orbs)
			advance(0)
			paint(0)
			renderer.render(scene, camera)
			lastReport = project()
			return lastReport
		},
		setActive(id) {
			if (activeId === id) return
			activeId = id
			lureAt = id ? lureToward(id) : null
			stir()
			wake()
		},
		setPalette,
		setMotion(next) {
			const calmed = next.reduced && !motion.reduced
			motion = next
			if (calmed) {
				contents = createLanternContents(lanternOrbHomes)
				spin = createLanternSpin()
				endTrial('fast')
			}
			wake()
		},
		setVisible(next) {
			if (next && !visible) stir()
			visible = next
			if (!next) {
				cancelFrame?.()
				cancelFrame = null
			}
			wake()
		},
		celebrate(id) {
			stir()
			const fx = effects.get(id)
			const at = orbRoot(id)
			if (!fx || !at || motion.reduced) return
			fx.spunAt = time
			fx.pop = 1
			model.burst.emit(
				new Vector3(at.x, at.y, at.z),
				colors.get(id) ?? new Color(1, 1, 1),
				{ count: 30, speed: 0.75, time },
			)
			wake()
		},
		nudge() {
			stir()
			if (motion.reduced) return
			spin = {
				...spin,
				yawVelocity: spin.yawVelocity + (Math.random() < 0.5 ? -2.4 : 2.4),
				tiltVelocity: spin.tiltVelocity + 1.4,
			}
			excitement = Math.min(excitement + 0.25, 0.45)
			wake()
		},
		spin(direction, big) {
			stir()
			if (motion.reduced) {
				spin = { ...spin, yaw: spin.yaw + direction * (Math.PI / 4) }
			} else {
				const kick = direction * (big ? 11 : 4.5)
				spin = {
					...spin,
					yawVelocity: Math.max(
						-lanternMaxSpin,
						Math.min(lanternMaxSpin, spin.yawVelocity + kick),
					),
				}
			}
			wake()
		},
		beginTurn(x, y, t) {
			stir()
			turning = {
				lastX: x,
				lastY: y,
				yaw: 0,
				tilt: 0,
				samples: [{ x: spin.yaw, y: spin.tilt, z: 0, t }],
			}
			wake()
		},
		turn(x, y, t) {
			if (!turning || frameBox.width === 0) return
			const yaw = ((x - turning.lastX) / frameBox.width) * turnPerWidth
			const tilt = ((y - turning.lastY) / frameBox.height) * tiltPerHeight
			turning.lastX = x
			turning.lastY = y
			turning.yaw += yaw
			turning.tilt += tilt
			const previous = turning.samples[turning.samples.length - 1]
			turning.samples.push({
				x: (previous?.x ?? spin.yaw) + yaw,
				y: (previous?.y ?? spin.tilt) + tilt,
				z: 0,
				t,
			})
			if (turning.samples.length > 12) turning.samples.shift()
			wake()
		},
		endTurn(flick, t) {
			if (!turning) return
			stir()
			const { samples, yaw, tilt } = turning
			turning = null
			// A release can land before the frame that applies the last moves.
			// Both branches below replace the velocities this sets.
			spin = dragLanternSpin(spin, { yaw, tilt }, 1 / 60)
			if (motion.reduced) {
				// No coast and no ease back: it keeps its turn and stands up.
				spin = { ...spin, tilt: 0, yawVelocity: 0, tiltVelocity: 0 }
			} else {
				const velocity = flick
					? lanternFlickVelocity(samples, t, lanternMaxSpin)
					: { vx: 0, vy: 0, vz: 0 }
				spin = {
					...spin,
					yawVelocity: velocity.vx,
					tiltVelocity: velocity.vy * 0.5,
				}
			}
			wake()
		},
		grabOrb(id, x, y, t) {
			stir()
			const orb = orbRoot(id)
			if (!orb) return
			const at = rootPoint(x, y, orb.z)
			if (!at) return
			hold = {
				id,
				z: orb.z,
				offset: { x: orb.x - at.x, y: orb.y - at.y },
				samples: [{ x: orb.x, y: orb.y, z: orb.z, t }],
				pose: { id, x: orb.x, y: orb.y, z: orb.z, vx: 0, vy: 0, vz: 0 },
			}
			wake()
		},
		moveOrb(x, y, t) {
			if (!hold) return
			const at = rootPoint(x, y, hold.z)
			if (!at) return
			const px = at.x + hold.offset.x
			const py = at.y + hold.offset.y
			hold.samples.push({ x: px, y: py, z: hold.z, t })
			if (hold.samples.length > 12) hold.samples.shift()
			const velocity = lanternFlickVelocity(hold.samples, t)
			hold.pose = {
				id: hold.id,
				x: px,
				y: py,
				z: hold.z,
				vx: velocity.vx,
				vy: velocity.vy,
				vz: velocity.vz,
			}
			wake()
		},
		releaseOrb(flick, t) {
			if (!hold) return
			stir()
			const { id, pose, samples } = hold
			hold = null
			if (motion.reduced) {
				contents = {
					...createLanternContents(lanternOrbHomes),
					swirlAngle: contents.swirlAngle,
					yaw: contents.yaw,
				}
			} else if (pose) {
				const flung = flick
					? lanternFlickVelocity(samples, t)
					: { vx: 0, vy: 0, vz: 0 }
				const tossed = Math.hypot(flung.vx, flung.vy, flung.vz) > 0
				const angle = contents.swirlAngle
				const tilt = displayTilt()
				const velocity = lanternRootToFluid(
					{ x: flung.vx, y: flung.vy, z: flung.vz },
					angle,
					tilt,
				)
				contents = {
					...contents,
					orbs: contents.orbs.map((orb) => {
						if (orb.id !== id) return orb
						return {
							...orb,
							...clampToCavity(
								lanternRootToFluid(pose, angle, tilt),
								orb.radius,
							),
							vx: velocity.x,
							vy: velocity.y,
							vz: velocity.z,
							coasting: tossed,
						}
					}),
				}
			}
			wake()
		},
		look(x, y) {
			pointer = { x, y }
			if (!motion.reduced) wake()
		},
		stopLooking() {
			pointer = null
		},
		trial() {
			return new Promise((done) => {
				if (motion.reduced) return done('fast')
				trial = { stamps: [], done }
				wake()
			})
		},
		dispose() {
			disposed = true
			cancelFrame?.()
			cancelFrame = null
			canvas.removeEventListener('webglcontextlost', onLost)
			model.dispose()
			environment.dispose()
			renderer.dispose()
			if (!lost) renderer.forceContextLoss()
		},
	}
}

/** Compile one part's shaders without stalling: with
 *  KHR_parallel_shader_compile the driver builds them while this waits. */
function compile(
	renderer: WebGLRenderer,
	part: Object3D,
	camera: PerspectiveCamera,
	scene: Scene,
) {
	return renderer.compileAsync(part, camera, scene).then(() => undefined)
}

/** Nothing moved enough to redraw the hotspots or leader lines. */
function sameFrame(a: LanternSceneFrame, b: LanternSceneFrame) {
	if (a.width !== b.width || a.height !== b.height) return false
	if (a.orbs.length !== b.orbs.length) return false
	return a.orbs.every((orb, index) => {
		const other = b.orbs[index]
		return (
			other !== undefined &&
			orb.id === other.id &&
			orb.order === other.order &&
			Math.abs(orb.x - other.x) < 0.05 &&
			Math.abs(orb.y - other.y) < 0.05 &&
			Math.abs(orb.radius - other.radius) < 0.05
		)
	})
}

/** Worker frames follow the display where the browser offers them. Each
 *  request returns its own cancel. */
function frameClock(): (callback: (now: number) => void) => () => void {
	if (typeof requestAnimationFrame === 'function') {
		return (callback) => {
			const handle = requestAnimationFrame(callback)
			return () => cancelAnimationFrame(handle)
		}
	}
	return (callback) => {
		const handle = setTimeout(() => callback(performance.now()), 16)
		return () => clearTimeout(handle)
	}
}

/** Resolves once the GPU has run every command issued so far, without
 *  blocking. The first frame (every shader, the environment map) can take
 *  a while, and the trial should time the frames after it. */
function gpuCaughtUp(gl: WebGLRenderingContext | WebGL2RenderingContext) {
	if (!('fenceSync' in gl)) return Promise.resolve()
	const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
	if (!sync) return Promise.resolve()
	gl.flush()
	return new Promise<void>((resolve) => {
		const check = () => {
			if (gl.isContextLost()) return resolve()
			if (gl.getSyncParameter(sync, gl.SYNC_STATUS) !== gl.SIGNALED) {
				setTimeout(check, 16)
				return
			}
			gl.deleteSync(sync)
			resolve()
		}
		// A fence never signals within the task that set it.
		setTimeout(check, 16)
	})
}
