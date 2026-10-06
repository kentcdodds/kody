import {
	type BufferGeometry,
	CatmullRomCurve3,
	CylinderGeometry,
	ExtrudeGeometry,
	Path,
	Quaternion,
	Shape,
	SphereGeometry,
	TorusGeometry,
	TubeGeometry,
	Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'

/**
 * The orb icons as solid shapes: the brain with its circuit traces, the
 * padlock, the package cube, the bolt, the two plugs, and the app grid.
 * Each glyph is centred and scaled so its larger side is one unit, facing
 * +z, so the model can size it to the orb and turn it to face the viewer.
 */

type Point = readonly [x: number, y: number]

const stroke = 0.045

/** Glyphs draw at a few dozen pixels, so the curves stay coarse. */
const extrusion = {
	depth: 0.1,
	bevelEnabled: true,
	bevelThickness: 0.03,
	bevelSize: 0.024,
	bevelSegments: 2,
	curveSegments: 6,
} as const

/** Strokes run through the middle of the extrusions' depth. */
const middle = extrusion.depth / 2

export function createGlyphGeometry(id: LandingPrimitiveId): BufferGeometry {
	const parts = glyphParts(id)
	const merged = mergeGeometries(
		parts.map((part) => (part.index ? part.toNonIndexed() : part)),
	)
	for (const part of parts) part.dispose()
	merged.computeBoundingBox()
	const box = merged.boundingBox!
	const centre = box.getCenter(new Vector3())
	const size = box.getSize(new Vector3())
	merged.translate(-centre.x, -centre.y, -centre.z)
	const scale = 1 / Math.max(size.x, size.y)
	merged.scale(scale, scale, scale)
	return merged
}

function glyphParts(id: LandingPrimitiveId): Array<BufferGeometry> {
	switch (id) {
		case 'memory':
			return brain()
		case 'secrets':
			return padlock()
		case 'packages':
			return cube()
		case 'triggers':
			return bolt()
		case 'integrations':
			return plugs()
		case 'apps':
			return tiles()
		default: {
			const exhaustive: never = id
			return exhaustive
		}
	}
}

/** Scalloped outline, a stem down the middle, and four traces that end in
 *  rings, like the memory orb art. */
function brain() {
	const outline: Array<Vector3> = []
	const samples = 100
	for (let i = 0; i < samples; i++) {
		const t = (i / samples) * Math.PI * 2
		const scallop = 1 + 0.075 * Math.cos(10 * t)
		outline.push(
			new Vector3(
				Math.cos(t) * 0.46 * scallop,
				Math.sin(t) * 0.37 * scallop + 0.05,
				middle,
			),
		)
	}
	return [
		new TubeGeometry(new CatmullRomCurve3(outline, true), 140, stroke, 8, true),
		...polyline([
			[0, 0.36],
			[0, -0.5],
		]),
		...polyline([
			[0, 0.13],
			[-0.15, 0.13],
			[-0.15, 0.2],
		]),
		ring([-0.15, 0.26]),
		...polyline([
			[0, -0.07],
			[-0.19, -0.07],
		]),
		ring([-0.25, -0.07]),
		...polyline([
			[0, 0.05],
			[0.16, 0.05],
			[0.16, 0.13],
		]),
		ring([0.16, 0.19]),
		...polyline([
			[0, -0.17],
			[0.19, -0.17],
		]),
		ring([0.25, -0.17]),
	]
}

function padlock() {
	const body = roundedRect(-0.33, -0.44, 0.66, 0.52, 0.1)
	const keyhole = new Path()
	const centre: Point = [0, -0.14]
	const radius = 0.075
	const neck = 0.032
	const meet = Math.sqrt(radius * radius - neck * neck)
	keyhole.moveTo(-0.05, -0.34)
	keyhole.lineTo(-neck, centre[1] - meet)
	keyhole.absarc(
		centre[0],
		centre[1],
		radius,
		Math.atan2(-meet, -neck),
		Math.atan2(-meet, neck),
		true,
	)
	keyhole.lineTo(0.05, -0.34)
	keyhole.lineTo(-0.05, -0.34)
	body.holes.push(keyhole)

	const arch: Array<Vector3> = [
		new Vector3(-0.2, 0.04, middle),
		new Vector3(-0.2, 0.14, middle),
	]
	for (let i = 0; i <= 16; i++) {
		const angle = Math.PI - (i / 16) * Math.PI
		arch.push(
			new Vector3(Math.cos(angle) * 0.2, 0.2 + Math.sin(angle) * 0.2, middle),
		)
	}
	arch.push(new Vector3(0.2, 0.14, middle), new Vector3(0.2, 0.04, middle))
	return [
		new ExtrudeGeometry(body, extrusion),
		new TubeGeometry(new CatmullRomCurve3(arch), 40, 0.06, 10, false),
	]
}

/** Three faces of an isometric cube, pulled apart so the seams read. */
function cube() {
	const r = 0.5
	const c = r * Math.cos(Math.PI / 6)
	const faces: Array<ReadonlyArray<Point>> = [
		[
			[0, r],
			[c, r / 2],
			[0, 0],
			[-c, r / 2],
		],
		[
			[-c, r / 2],
			[0, 0],
			[0, -r],
			[-c, -r / 2],
		],
		[
			[0, 0],
			[c, r / 2],
			[c, -r / 2],
			[0, -r],
		],
	]
	return faces.map(
		(face) =>
			new ExtrudeGeometry(roundedPolygon(shrink(face, 0.84), 0.05), extrusion),
	)
}

function bolt() {
	const points: ReadonlyArray<Point> = [
		[0.1, 0.5],
		[-0.27, -0.02],
		[-0.03, -0.02],
		[-0.13, -0.5],
		[0.27, 0.05],
		[0.03, 0.05],
	]
	return [new ExtrudeGeometry(roundedPolygon(points, 0.035), extrusion)]
}

/** Two plugs about to meet on the diagonal: prongs from the lower left,
 *  the socket from the upper right, each trailing its cable. */
function plugs() {
	const plug = new Shape()
	plug.moveTo(-0.1, 0.15)
	plug.lineTo(-0.22, 0.15)
	plug.absarc(-0.22, 0, 0.15, Math.PI / 2, (Math.PI * 3) / 2, false)
	plug.lineTo(-0.1, -0.15)
	plug.lineTo(-0.1, 0.15)

	const socket = new Shape()
	socket.moveTo(0.1, -0.15)
	socket.lineTo(0.24, -0.15)
	socket.absarc(0.24, 0, 0.15, -Math.PI / 2, Math.PI / 2, false)
	socket.lineTo(0.1, 0.15)
	socket.lineTo(0.1, -0.15)

	const parts = [
		new ExtrudeGeometry(plug, extrusion),
		new ExtrudeGeometry(socket, extrusion),
		...polyline(
			[
				[-0.1, 0.07],
				[0.02, 0.07],
			],
			0.03,
		),
		...polyline(
			[
				[-0.1, -0.07],
				[0.02, -0.07],
			],
			0.03,
		),
		...polyline([
			[-0.36, 0],
			[-0.6, 0],
		]),
		...polyline([
			[0.38, 0],
			[0.62, 0],
		]),
	]
	for (const part of parts) part.rotateZ(Math.PI / 4)
	return parts
}

function tiles() {
	const size = 0.4
	const gap = 0.1
	const offset = (size + gap) / 2
	const parts: Array<BufferGeometry> = []
	for (const x of [-offset, offset]) {
		for (const y of [-offset, offset]) {
			parts.push(
				new ExtrudeGeometry(
					roundedRect(x - size / 2, y - size / 2, size, size, 0.09),
					extrusion,
				),
			)
		}
	}
	return parts
}

/** Capsules along a polyline: round caps and round joins. */
function polyline(points: ReadonlyArray<Point>, radius = stroke) {
	const z = middle
	const parts: Array<BufferGeometry> = []
	const up = new Vector3(0, 1, 0)
	for (let i = 0; i < points.length; i++) {
		const [x, y] = points[i]!
		const joint = new SphereGeometry(radius, 10, 6)
		joint.translate(x, y, z)
		parts.push(joint)
		const next = points[i + 1]
		if (!next) continue
		const from = new Vector3(x, y, z)
		const to = new Vector3(next[0], next[1], z)
		const direction = to.clone().sub(from)
		const segment = new CylinderGeometry(
			radius,
			radius,
			direction.length(),
			10,
			1,
			true,
		)
		segment.applyQuaternion(
			new Quaternion().setFromUnitVectors(up, direction.clone().normalize()),
		)
		const middle = from.add(to).multiplyScalar(0.5)
		segment.translate(middle.x, middle.y, middle.z)
		parts.push(segment)
	}
	return parts
}

function ring([x, y]: Point) {
	const geometry = new TorusGeometry(0.055, stroke * 0.8, 8, 20)
	geometry.translate(x, y, middle)
	return geometry
}

function roundedRect(
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
) {
	return roundedPolygon(
		[
			[x, y],
			[x + width, y],
			[x + width, y + height],
			[x, y + height],
		],
		radius,
	)
}

/** A closed polygon whose corners are cut back by `radius` along each edge
 *  and joined with a curve through the corner. */
function roundedPolygon(points: ReadonlyArray<Point>, radius: number) {
	const shape = new Shape()
	const count = points.length
	for (let i = 0; i < count; i++) {
		const previous = points[(i - 1 + count) % count]!
		const corner = points[i]!
		const next = points[(i + 1) % count]!
		const enter = toward(corner, previous, radius)
		const leave = toward(corner, next, radius)
		if (i === 0) shape.moveTo(enter[0], enter[1])
		else shape.lineTo(enter[0], enter[1])
		shape.quadraticCurveTo(corner[0], corner[1], leave[0], leave[1])
	}
	shape.closePath()
	return shape
}

/** The point `distance` from `from` toward `to`, at most halfway. */
function toward(from: Point, to: Point, distance: number): Point {
	const dx = to[0] - from[0]
	const dy = to[1] - from[1]
	const length = Math.hypot(dx, dy)
	const step = Math.min(distance, length / 2) / length
	return [from[0] + dx * step, from[1] + dy * step]
}

function shrink(points: ReadonlyArray<Point>, factor: number) {
	const cx = points.reduce((sum, [x]) => sum + x, 0) / points.length
	const cy = points.reduce((sum, [, y]) => sum + y, 0) / points.length
	return points.map(([x, y]): Point => [
		cx + (x - cx) * factor,
		cy + (y - cy) * factor,
	])
}
