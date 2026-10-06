import {
	BackSide,
	BoxGeometry,
	Color,
	FrontSide,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	Scene,
	type Side,
} from 'three'

/**
 * The room the lantern reflects, rendered once into its environment map:
 * dim and warm, with a softbox overhead and behind, a window up and to the
 * right, and a tall strip on the left, where the still's glass catches its
 * highlights. Nothing bright sits behind the camera, so the middle of the
 * glass shows the glow rather than a reflection.
 */
export function createLanternStudio() {
	const scene = new Scene()
	const panel = new PlaneGeometry(1, 1)
	const roomGeometry = new BoxGeometry(18, 14, 18)
	const materials: Array<MeshBasicMaterial> = []
	const material = (color: Color, side: Side = FrontSide) => {
		const created = new MeshBasicMaterial({ color, side })
		materials.push(created)
		return created
	}

	scene.add(
		new Mesh(roomGeometry, material(new Color(0.09, 0.078, 0.066), BackSide)),
	)

	const lights: ReadonlyArray<{
		intensity: number
		at: readonly [number, number, number]
		size: readonly [number, number]
	}> = [
		{ intensity: 2.4, at: [0, 6, -2.5], size: [7, 4] },
		{ intensity: 5.5, at: [4.6, 3.2, 3.8], size: [2.4, 3.4] },
		{ intensity: 3, at: [-5.6, 0.6, -1.6], size: [0.9, 6.5] },
		{ intensity: 0.5, at: [0, -6, 1], size: [8, 8] },
	]
	for (const light of lights) {
		const mesh = new Mesh(
			panel,
			material(new Color().setScalar(light.intensity)),
		)
		mesh.position.set(...light.at)
		mesh.scale.set(light.size[0], light.size[1], 1)
		mesh.lookAt(0, 0, 0)
		scene.add(mesh)
	}

	return {
		scene,
		dispose() {
			panel.dispose()
			roomGeometry.dispose()
			for (const item of materials) item.dispose()
		},
	}
}
