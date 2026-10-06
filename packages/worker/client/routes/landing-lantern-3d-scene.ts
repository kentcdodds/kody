import { mountAsync } from 'gss-lang/runtime'
import lanternScene from './landing-lantern-3d.gss'

/**
 * The GSS half of the 3D lantern. `landing-lantern-3d.tsx` imports this
 * module on demand, so the runtime and the compiled shaders stay out of
 * the homepage chunk until the lantern is about to scroll into view.
 */

/** Fetch the orb glyphs, so they are in the image cache when the scene asks
 *  for them. GSS loads textures as anonymous CORS images, and the cache is
 *  keyed by CORS mode. Rejects if a glyph cannot load: GSS only warns and
 *  draws that orb blank. */
export async function preloadLanternTextures() {
	await Promise.all(
		lanternScene.textures.map(
			(src) =>
				new Promise<void>((resolve, reject) => {
					const image = new Image()
					image.crossOrigin = 'anonymous'
					image.onload = () => resolve()
					image.onerror = () =>
						reject(new Error(`Cannot load the lantern glyph ${src}`))
					image.src = src
				}),
		),
	)
}

/**
 * Mount the scene on `canvas`. GSS's own camera controls stay off: the
 * component turns the lantern through `--yaw`, and the page keeps the
 * wheel. `onLost` fires once if the GPU context goes away.
 */
export async function mountLanternScene(
	canvas: HTMLCanvasElement,
	onLost: () => void,
) {
	let lost = false
	const lose = (event: Event) => {
		event.preventDefault()
		if (lost) return
		lost = true
		onLost()
	}
	canvas.addEventListener('webglcontextlost', lose)
	canvas.addEventListener('gss-error', lose)
	const stopListening = () => {
		canvas.removeEventListener('webglcontextlost', lose)
		canvas.removeEventListener('gss-error', lose)
	}
	try {
		const view = await mountAsync(canvas, lanternScene, { controls: false })
		return {
			backend: view.backend,
			set: (name: string, value: string | number) =>
				view.setProperty(name, value),
			destroy() {
				stopListening()
				view.destroy()
			},
		}
	} catch (error) {
		stopListening()
		throw error
	}
}
