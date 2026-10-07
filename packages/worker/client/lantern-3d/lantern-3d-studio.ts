import {
	BackSide,
	BufferAttribute,
	Color,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	Scene,
	SphereGeometry,
} from 'three'

type Triple = readonly [number, number, number]

/**
 * The key, fill, and rim lights. Each one sits at its softbox in the
 * studio, so what lights the metal and the highlight it shows in the glass
 * and the orbs come from the same place. Intensities are physical: a
 * surface facing a light gets `intensity` of irradiance from it.
 */
export const lanternLights: Record<
	'key' | 'fill' | 'rim',
	{ at: Triple; color: Triple; intensity: number }
> = {
	/** High in front, a little right: the sheen down the front of the cap
	 *  and the base, the tops of the lid and handle, and the big pane on
	 *  the glass's upper half. */
	key: { at: [0.8, 5.6, 4.2], color: [1, 0.96, 0.9], intensity: 2.4 },
	/** Low on the left, in front, and cool: just enough to read the shadow
	 *  side. */
	fill: { at: [-6, 1, 4], color: [0.8, 0.88, 1], intensity: 0.5 },
	/** The window behind the right shoulder: an edge against the page. */
	rim: { at: [5, 3, -3.8], color: [1, 0.94, 0.86], intensity: 1.4 },
}

/** Linear sRGB radiance. Bright enough that a panel still reads white in
 *  glass, which reflects only a few percent of it face-on. */
const studioPanels: ReadonlyArray<{
	radiance: Triple
	at: Triple
	size: readonly [number, number]
}> = [
	{ radiance: [5.5, 5.3, 5], at: lanternLights.key.at, size: [4.2, 3] },
	{ radiance: [26, 24.5, 22], at: lanternLights.rim.at, size: [0.9, 3.8] },
	{ radiance: [16, 15, 13.5], at: [4.2, 3, -4.8], size: [0.45, 3.8] },
	{ radiance: [6.4, 7.4, 8.6], at: [-6.7, 2.75, -2], size: [0.8, 2.2] },
	{ radiance: [6.4, 7.4, 8.6], at: [-6.7, 0.4, -2], size: [0.8, 2.2] },
	{ radiance: [6.4, 7.4, 8.6], at: [-6.7, -1.95, -2], size: [0.8, 2.2] },
	{ radiance: [1.8, 1.75, 1.7], at: [0, 7, 0.8], size: [5, 3] },
	{ radiance: [5.5, 4.9, 4.2], at: [-2.5, 2.4, -6.5], size: [2.6, 3] },
	{ radiance: [0.25, 0.26, 0.28], at: lanternLights.fill.at, size: [7, 5] },
	{ radiance: [0.3, 0.17, 0.06], at: [0, -6, 0], size: [7, 7] },
]

const domeRadius = 12

/** Dome colors below the horizon, at it, and overhead. */
const dome = {
	below: new Color(0.012, 0.009, 0.006),
	horizon: new Color(0.04, 0.036, 0.032),
	above: new Color(0.07, 0.068, 0.066),
} as const

/**
 * The studio the lantern reflects, rendered once into its environment map.
 * A dome that is dark below the horizon and a little lighter above gives
 * the metal a soft horizon in its reflections. The softboxes sit where the
 * still's highlights say they were:
 *
 * - the key, high in front: the pane over the glass's upper half, the
 *   window on each orb, and the sheen down the front of the metal
 * - a window of two panes behind the right shoulder: the bands that curve
 *   down the right of the globe
 * - a cool strip of three panes on the left, a little behind: the streaks
 *   down the left of the globe and the blue edge on the metal
 * - one overhead for the tops of the lid, cap, and handle, one behind on
 *   the left for an edge on the metal against the page, and the lantern's
 *   own warm light coming back off the table
 *
 * The fill's softbox is broad and dim: the glass in front of the glow
 * would show anything brighter as a haze. For the same reason the key's is
 * dimmer than the windows: face-on, the glass shows it as a veil.
 */
export function createLanternStudio() {
	const scene = new Scene()
	const panel = new PlaneGeometry(1, 1)
	const sky = new SphereGeometry(domeRadius, 64, 32)
	const position = sky.getAttribute('position')
	const colors = new Float32Array(position.count * 3)
	const color = new Color()
	for (let i = 0; i < position.count; i++) {
		const up = position.getY(i) / domeRadius
		if (up < 0) color.copy(dome.horizon).lerp(dome.below, Math.min(-up * 3, 1))
		else color.copy(dome.horizon).lerp(dome.above, Math.min(up * 1.6, 1))
		colors.set([color.r, color.g, color.b], i * 3)
	}
	sky.setAttribute('color', new BufferAttribute(colors, 3))
	const skyMaterial = new MeshBasicMaterial({
		vertexColors: true,
		side: BackSide,
	})
	const materials = [skyMaterial]
	scene.add(new Mesh(sky, skyMaterial))

	for (const light of studioPanels) {
		const material = new MeshBasicMaterial({
			color: new Color(...light.radiance),
		})
		materials.push(material)
		const mesh = new Mesh(panel, material)
		mesh.position.set(...light.at)
		mesh.scale.set(light.size[0], light.size[1], 1)
		mesh.lookAt(0, 0, 0)
		scene.add(mesh)
	}

	return {
		scene,
		dispose() {
			panel.dispose()
			sky.dispose()
			for (const item of materials) item.dispose()
		},
	}
}
