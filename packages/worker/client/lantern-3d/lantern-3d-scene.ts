import {
	Color,
	Matrix4,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	NeutralToneMapping,
	PerspectiveCamera,
	PMREMGenerator,
	Plane,
	Quaternion,
	Raycaster,
	Scene,
	SRGBColorSpace,
	type Texture,
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
	lanternCavity,
	lanternOrbRadius,
	lanternOrbRests,
	lanternStill,
} from './lantern-3d-layout.ts'
import {
	createLanternModel,
	lanternViewPitch,
	paintLanternOrb,
	type LanternOrbView,
} from './lantern-3d-model.ts'
import {
	clampToCavity,
	createLanternContents,
	createLanternSpin,
	dragLanternSpin,
	lanternFlickVelocity,
	lanternMaxSpin,
	lanternTiltLimit,
	stepLanternContents,
	stepLanternSpin,
	type LanternContents,
	type LanternOrbHold3d,
	type LanternPointerSample3d,
	type Vec3,
} from './lantern-3d-motion.ts'
import {
	createLanternQuality,
	resizeLanternQuality,
	stepLanternQuality,
	type LanternQuality,
} from './lantern-3d-quality.ts'
import { createLanternStudio } from './lantern-3d-studio.ts'

/**
 * The live 3D lantern: renderer, camera, and frame loop. The camera is
 * fitted so the lantern lands on the 2D still's box (the frame element),
 * whatever size the canvas bleeds to. Each frame reports where the orbs
 * project so the page can keep its hotspots and leader lines on them.
 *
 * Reduced motion keeps the scene still: no wander, twinkle, fireflies, or
 * coasting, and frames draw only when something changes. Pointer turns and
 * drags still respond directly.
 *
 * A software renderer gets the lite model, no multisampling, and a lower
 * resolution, so the CPU it shares with the page stays usable.
 */

export type LanternPalette = {
	/** A CSS color, as `--primitive-<id>` resolves on the page. */
	color: (id: LandingPrimitiveId) => string
	dark: boolean
}

export type LanternMotion = {
	reduced: boolean
	/** Share of the full wander; small screens use less. */
	wander: number
}

type LanternOrbFrame = {
	id: LandingPrimitiveId
	/** Centre in CSS pixels from the frame's top left. */
	x: number
	y: number
	/** Projected radius in CSS pixels. */
	radius: number
	/** 1 is the farthest orb. */
	order: number
}

export type LanternSceneFrame = {
	orbs: ReadonlyArray<LanternOrbFrame>
	width: number
	height: number
}

export type LanternSceneOptions = {
	canvas: HTMLCanvasElement
	/** The lantern's layout box, where the 2D still sits. */
	frame: HTMLElement
	palette: LanternPalette
	motion: LanternMotion
	onFrame: (frame: LanternSceneFrame) => void
	onLost: () => void
}

export type LanternScene = {
	/** Resolves once the shaders compile and the first frame is drawn. */
	ready: Promise<void>
	layout: () => void
	setActive: (id: LandingPrimitiveId | null) => void
	setPalette: (palette: LanternPalette) => void
	setMotion: (motion: LanternMotion) => void
	setVisible: (visible: boolean) => void
	/** Start the orbs where the 2D lantern has them, in frame pixels. */
	placeOrbs: (
		points: ReadonlyArray<{ id: LandingPrimitiveId; x: number; y: number }>,
	) => void
	celebrate: (id: LandingPrimitiveId) => void
	/** A tap on the lantern itself. */
	nudge: () => void
	/** Keyboard and button turns: -1 or 1, with a flourish for `big`. */
	spin: (direction: number, big?: boolean) => void
	beginTurn: (clientX: number, clientY: number) => void
	turn: (clientX: number, clientY: number) => void
	endTurn: (flick: boolean) => void
	grabOrb: (id: LandingPrimitiveId, clientX: number, clientY: number) => void
	moveOrb: (clientX: number, clientY: number) => void
	/** True when the orb flies off, so the page can hold its hover shut. */
	releaseOrb: (flick: boolean) => boolean
	look: (clientX: number, clientY: number) => void
	stopLooking: () => void
	dispose: () => void
}

const fov = 24

/** Device pixels the canvas may draw, so a big screen cannot ask for 4K. */
const maxPixels = 2_600_000

/** Drag across the whole lantern turns it this far, radians. */
const turnPerWidth = 2.8
const tiltPerHeight = 1.4

/** How far the open orb comes toward you, along its line of sight so it
 *  stays under the pointer that opened it. */
const lureDepth = 0.5

type OrbEffects = {
	lit: number
	dim: number
	pop: number
	spunAt: number | null
	lookYaw: number
	lookPitch: number
	velocity: Vec3
}

export function createLanternScene(options: LanternSceneOptions): LanternScene {
	const { canvas, frame } = options
	const software = drawsInSoftware()
	const renderer = new WebGLRenderer({
		canvas,
		alpha: true,
		// Multisampling multiplies a software renderer's per-pixel cost.
		antialias: !software,
		powerPreference: 'default',
	})
	renderer.setClearColor(0x000000, 0)
	renderer.outputColorSpace = SRGBColorSpace
	renderer.toneMapping = NeutralToneMapping
	renderer.toneMappingExposure = 1

	const scene = new Scene()
	const camera = new PerspectiveCamera(fov, 1, 1, 30)
	const model = createLanternModel({ lite: software })
	scene.add(model.root, model.ground)

	const pmrem = new PMREMGenerator(renderer)
	const studio = createLanternStudio()
	const environment: Texture = pmrem.fromScene(studio.scene, 0.04).texture
	studio.dispose()
	pmrem.dispose()
	model.root.traverse((object) => {
		if (!('material' in object)) return
		const material = object.material
		if (
			material instanceof MeshPhysicalMaterial ||
			material instanceof MeshStandardMaterial
		) {
			material.envMap = environment
			material.needsUpdate = true
		}
	})

	const rests = lanternOrbRests.map((rest) =>
		unpitch({ id: rest.id, x: rest.x, y: rest.y, z: rest.depth }),
	)
	let contents: LanternContents = createLanternContents(rests)
	let spin = createLanternSpin()
	let motion = options.motion
	let time = 0
	let visible = true
	let disposed = false
	let lost = false
	/** No frames until the shaders compile, so the first draw cannot stall. */
	let started = false
	let activeId: LandingPrimitiveId | null = null
	let lureAt: Vec3 | null = null
	let excitement = 0
	let quality: LanternQuality = createLanternQuality({
		devicePixelRatio: window.devicePixelRatio,
		cssPixels: 1,
		maxPixels,
		software,
	})

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
				velocity: { x: 0, y: 0, z: 0 },
			},
		]),
	)
	const colors = new Map<LandingPrimitiveId, Color>()

	const size = { width: 0, height: 0 }
	const frameBox = { left: 0, top: 0, width: 0, height: 0 }
	let focal = 1

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

	let raf: number | null = null
	let last = performance.now()
	let lastFrameAt: number | null = null

	function unpitch(rest: Vec3 & { id: LandingPrimitiveId }) {
		// Root tips the scene toward the viewer. Undo that so each orb
		// still lands on its place in the still.
		const c = Math.cos(lanternViewPitch)
		const s = Math.sin(lanternViewPitch)
		return {
			id: rest.id,
			x: rest.x,
			y: rest.y * c + rest.z * s,
			z: -rest.y * s + rest.z * c,
		}
	}

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
	}

	function layout() {
		if (disposed) return
		const canvasRect = canvas.getBoundingClientRect()
		const frameRect = frame.getBoundingClientRect()
		if (canvasRect.width === 0 || frameRect.width === 0) return
		size.width = canvasRect.width
		size.height = canvasRect.height
		frameBox.left = frameRect.left - canvasRect.left
		frameBox.top = frameRect.top - canvasRect.top
		frameBox.width = frameRect.width
		frameBox.height = frameRect.height
		const unit = frameRect.width / lanternStill.width
		const distance = size.height / (2 * unit * Math.tan((fov * Math.PI) / 360))
		const glassX = frameBox.left + frameRect.width * landingLanternGlass.x
		const glassY = frameBox.top + frameRect.height * landingLanternGlass.y
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
			devicePixelRatio: window.devicePixelRatio,
			cssPixels: size.width * size.height,
			maxPixels,
			software,
		})
		applySize()
		wake()
	}

	function setPalette(palette: LanternPalette) {
		for (const orb of model.orbs) {
			const rgb = parseCssColor(palette.color(orb.id))
			const color = rgb ? new Color(...rgb) : new Color(1, 0.6, 0.2)
			colors.set(orb.id, color)
			paintLanternOrb(orb, color)
		}
		model.aura.opacity = palette.dark ? 0.5 : 0.32
		model.pool.opacity = palette.dark ? 0.55 : 0.38
		model.shadow.opacity = palette.dark ? 0.5 : 0.26
		model.fireflies.uniforms.uOpacity!.value = palette.dark ? 1 : 0.9
		wake()
	}

	function orbState(id: LandingPrimitiveId) {
		return contents.orbs.find((orb) => orb.id === id) ?? null
	}

	function lure() {
		if (!activeId || !lureAt || hold || motion.reduced) return null
		return { id: activeId, ...lureAt }
	}

	/** Toward the camera from where the orb is now, stopping short of the
	 *  glass. Moving along the view ray keeps it under the pointer, so a
	 *  hover cannot pull the orb out from under itself and close again. */
	function lureToward(id: LandingPrimitiveId): Vec3 | null {
		const orb = orbState(id)
		if (!orb) return null
		model.root.updateMatrixWorld()
		rootInverse.copy(model.root.matrixWorld).invert()
		axis.copy(camera.position).applyMatrix4(rootInverse)
		axis.set(axis.x - orb.x, axis.y - orb.y, axis.z - orb.z).normalize()
		const limit = lanternCavity.radius - orb.radius - 0.03
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

	/** A point under the pointer on the plane z = `depth` in root space. */
	function rootPoint(clientX: number, clientY: number, depth: number) {
		const rect = canvas.getBoundingClientRect()
		if (rect.width === 0 || rect.height === 0) return null
		pointerNdc.set(
			((clientX - rect.left) / rect.width) * 2 - 1,
			-(((clientY - rect.top) / rect.height) * 2 - 1),
		)
		camera.updateMatrixWorld()
		model.root.updateMatrixWorld()
		raycaster.setFromCamera(pointerNdc, camera)
		rootInverse.copy(model.root.matrixWorld).invert()
		const ray = raycaster.ray.clone().applyMatrix4(rootInverse)
		plane.set(new Vector3(0, 0, 1), -depth)
		return ray.intersectPlane(plane, hit)
	}

	function canvasPoint(clientX: number, clientY: number) {
		const rect = canvas.getBoundingClientRect()
		return { x: clientX - rect.left, y: clientY - rect.top }
	}

	function step(dt: number) {
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

		const tilt = displayTilt()
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
			spin: animate ? spin.yawVelocity : 0,
			tilt,
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
			if (!orb) continue
			const turn =
				previous.vx * orb.vx + previous.vy * orb.vy + previous.vz * orb.vz
			if (turn > 0) continue
			model.burst.emit(
				new Vector3(orb.x, orb.y, orb.z),
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
		const sway = animate ? Math.sin(time * 0.31) * 0.07 : 0
		const tilt = displayTilt()
		model.lantern.rotation.set(tilt, spin.yaw + look.yaw + sway, 0)
		model.fluid.rotation.x = tilt
		model.handle.rotation.x =
			spin.swing + (animate ? Math.sin(time * 0.9 + 0.4) * 0.03 : 0)

		const glow =
			1 + (animate ? Math.sin(time * 1.6) * 0.035 : 0) + excitement * 0.6
		model.glassInterior.uniforms.uGlow!.value = glow
		model.glassInterior.uniforms.uTime!.value = time
		model.glassFloor.uniforms.uGlow!.value = glow
		model.innerLight.intensity = 7 * glow
		model.sparkles.uniforms.uSwirl!.value = contents.swirlAngle
		model.sparkles.uniforms.uTime!.value = time
		model.sparkles.uniforms.uGlow!.value = 1 + excitement
		model.fireflies.uniforms.uTime!.value = time
		model.burst.points.material.uniforms.uTime!.value = time

		for (const orb of model.orbs) paintOrb(orb, dt, settle, animate)
	}

	function paintOrb(
		view: LanternOrbView,
		dt: number,
		settle: number,
		animate: boolean,
	) {
		const state = orbState(view.id)
		const fx = effects.get(view.id)
		if (!state || !fx) return
		view.group.position.set(state.x, state.y, state.z)

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

	function report() {
		if (frameBox.width === 0) return
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
		options.onFrame({
			orbs: orbs.map((orb) => ({
				id: orb.id,
				x: orb.x,
				y: orb.y,
				radius: orb.radius,
				order: byDepth.indexOf(orb) + 1,
			})),
			width: frameBox.width,
			height: frameBox.height,
		})
	}

	function busy() {
		if (hold || turning) return true
		if (motion.reduced) return false
		return true
	}

	function tick(now: number) {
		raf = null
		if (disposed) return
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
		step(dt)
		paint(dt)
		renderer.render(scene, camera)
		report()
		const keepGoing = visible && document.visibilityState !== 'hidden' && busy()
		lastFrameAt = keepGoing ? now : null
		if (keepGoing) raf = requestAnimationFrame(tick)
	}

	function wake() {
		if (disposed || !started || raf !== null) return
		if (!visible || document.visibilityState === 'hidden') return
		last = performance.now()
		raf = requestAnimationFrame(tick)
	}

	const onLost = (event: Event) => {
		event.preventDefault()
		lost = true
		if (raf !== null) cancelAnimationFrame(raf)
		raf = null
		options.onLost()
	}
	canvas.addEventListener('webglcontextlost', onLost)
	const onVisibility = () => wake()
	document.addEventListener('visibilitychange', onVisibility)

	setPalette(options.palette)
	layout()

	const ready = renderer.compileAsync(scene, camera).then(() => {
		if (disposed) return
		started = true
		step(0)
		paint(0)
		renderer.render(scene, camera)
		report()
		wake()
	})

	return {
		ready,
		layout,
		setActive(id) {
			if (activeId === id) return
			activeId = id
			lureAt = id ? lureToward(id) : null
			wake()
		},
		setPalette,
		setMotion(next) {
			const calmed = next.reduced && !motion.reduced
			motion = next
			if (calmed) {
				contents = createLanternContents(rests)
				spin = createLanternSpin()
			}
			wake()
		},
		setVisible(next) {
			visible = next
			if (next) wake()
		},
		placeOrbs(points) {
			if (frameBox.width === 0) return
			const canvasRect = canvas.getBoundingClientRect()
			contents = {
				...contents,
				orbs: contents.orbs.map((orb) => {
					const point = points.find((entry) => entry.id === orb.id)
					if (!point) return orb
					const at = rootPoint(
						canvasRect.left + frameBox.left + point.x,
						canvasRect.top + frameBox.top + point.y,
						orb.home.z,
					)
					if (!at) return orb
					return {
						...orb,
						...clampToCavity(at, orb.radius, 0),
						vx: 0,
						vy: 0,
						vz: 0,
					}
				}),
			}
			// Draw now: the loop may be parked offscreen, and the canvas must
			// not show the orbs anywhere else when it fades in.
			if (started) {
				paint(0)
				renderer.render(scene, camera)
				report()
			}
			wake()
		},
		celebrate(id) {
			const fx = effects.get(id)
			const orb = orbState(id)
			if (!fx || !orb || motion.reduced) return
			fx.spunAt = time
			fx.pop = 1
			model.burst.emit(
				new Vector3(orb.x, orb.y, orb.z),
				colors.get(id) ?? new Color(1, 1, 1),
				{ count: 30, speed: 0.75, time },
			)
			contents = {
				...contents,
				orbs: contents.orbs.map((entry) =>
					entry.id === id
						? { ...entry, vy: entry.vy + 0.55, coasting: true }
						: entry,
				),
			}
			wake()
		},
		nudge() {
			if (motion.reduced) return
			spin = {
				...spin,
				yawVelocity: spin.yawVelocity + (Math.random() < 0.5 ? -2.4 : 2.4),
				tiltVelocity: spin.tiltVelocity + 1.4,
			}
			excitement = Math.min(excitement + 0.25, 0.45)
			wake()
		},
		spin(direction, big = false) {
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
		beginTurn(clientX, clientY) {
			turning = {
				lastX: clientX,
				lastY: clientY,
				yaw: 0,
				tilt: 0,
				samples: [{ x: spin.yaw, y: spin.tilt, z: 0, t: performance.now() }],
			}
			wake()
		},
		turn(clientX, clientY) {
			if (!turning || frameBox.width === 0) return
			const yaw = ((clientX - turning.lastX) / frameBox.width) * turnPerWidth
			const tilt = ((clientY - turning.lastY) / frameBox.height) * tiltPerHeight
			turning.lastX = clientX
			turning.lastY = clientY
			turning.yaw += yaw
			turning.tilt += tilt
			const previous = turning.samples[turning.samples.length - 1]
			turning.samples.push({
				x: (previous?.x ?? spin.yaw) + yaw,
				y: (previous?.y ?? spin.tilt) + tilt,
				z: 0,
				t: performance.now(),
			})
			if (turning.samples.length > 12) turning.samples.shift()
			wake()
		},
		endTurn(flick) {
			if (!turning) return
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
					? lanternFlickVelocity(samples, performance.now(), lanternMaxSpin)
					: { vx: 0, vy: 0, vz: 0 }
				spin = {
					...spin,
					yawVelocity: velocity.vx,
					tiltVelocity: velocity.vy * 0.5,
				}
			}
			wake()
		},
		grabOrb(id, clientX, clientY) {
			const orb = orbState(id)
			if (!orb) return
			const at = rootPoint(clientX, clientY, orb.z)
			if (!at) return
			const now = performance.now()
			hold = {
				id,
				z: orb.z,
				offset: { x: orb.x - at.x, y: orb.y - at.y },
				samples: [{ x: orb.x, y: orb.y, z: orb.z, t: now }],
				pose: { id, x: orb.x, y: orb.y, z: orb.z, vx: 0, vy: 0, vz: 0 },
			}
			wake()
		},
		moveOrb(clientX, clientY) {
			if (!hold) return
			const at = rootPoint(clientX, clientY, hold.z)
			if (!at) return
			const now = performance.now()
			const x = at.x + hold.offset.x
			const y = at.y + hold.offset.y
			hold.samples.push({ x, y, z: hold.z, t: now })
			if (hold.samples.length > 12) hold.samples.shift()
			const velocity = lanternFlickVelocity(hold.samples, now)
			hold.pose = {
				id: hold.id,
				x,
				y,
				z: hold.z,
				vx: velocity.vx,
				vy: velocity.vy,
				vz: velocity.vz,
			}
			wake()
		},
		releaseOrb(flick) {
			if (!hold) return false
			const { id, pose, samples } = hold
			hold = null
			let tossed = false
			if (motion.reduced) {
				contents = createLanternContents(rests)
			} else if (pose) {
				const velocity = flick
					? lanternFlickVelocity(samples, performance.now())
					: { vx: 0, vy: 0, vz: 0 }
				tossed = Math.hypot(velocity.vx, velocity.vy, velocity.vz) > 0
				const tilt = displayTilt()
				contents = {
					...contents,
					orbs: contents.orbs.map((orb) => {
						if (orb.id !== id) return orb
						return {
							...orb,
							...clampToCavity(pose, orb.radius, tilt),
							vx: velocity.vx,
							vy: velocity.vy,
							vz: velocity.vz,
							coasting: tossed,
						}
					}),
				}
			}
			wake()
			return tossed
		},
		look(clientX, clientY) {
			pointer = canvasPoint(clientX, clientY)
			if (!motion.reduced) wake()
		},
		stopLooking() {
			pointer = null
		},
		dispose() {
			disposed = true
			if (raf !== null) cancelAnimationFrame(raf)
			raf = null
			canvas.removeEventListener('webglcontextlost', onLost)
			document.removeEventListener('visibilitychange', onVisibility)
			model.dispose()
			environment.dispose()
			renderer.dispose()
			if (!lost) renderer.forceContextLoss()
		},
	}
}

/** Software rasterizers seen in the wild: Chrome's, Mesa's, and Windows'. */
const softwareRenderer = /swiftshader|llvmpipe|softpipe|basic render|software/i

/** Some browsers refuse a context that asks to fail on a major
 *  performance caveat when WebGL would run on the CPU; others only say so
 *  in the renderer's name. */
function drawsInSoftware() {
	const probe = document
		.createElement('canvas')
		.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
	if (!probe) return true
	const info = probe.getExtension('WEBGL_debug_renderer_info')
	const name: unknown = probe.getParameter(
		info ? info.UNMASKED_RENDERER_WEBGL : probe.RENDERER,
	)
	probe.getExtension('WEBGL_lose_context')?.loseContext()
	return typeof name === 'string' && softwareRenderer.test(name)
}
