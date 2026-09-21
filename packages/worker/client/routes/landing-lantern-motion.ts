import { ref } from 'remix/ui'
import {
	createLanternOrbBodies,
	stepLanternOrbMotion,
	type LanternOrbBody,
} from '#universal/landing-lantern-motion.ts'

/** Bubbles from the lantern so the leader overlay can redraw in the same frame. */
export const lanternOrbMotionEvent = 'lantern-orb-motion'

const homes = new Map(
	createLanternOrbBodies().map((body) => [
		body.id,
		{ x: body.homeX, y: body.homeY },
	]),
)

/**
 * Move the orb layers and their hotspots together. Reduced motion leaves
 * every layer on its rest pose. A phone uses a shorter wander so the small
 * lantern does not look busy.
 */
export function lanternOrbMotion() {
	return ref((node: Element, signal: AbortSignal) => {
		if (!(node instanceof HTMLElement)) return
		const motionOk = matchMedia('(prefers-reduced-motion: no-preference)')
		const narrow = matchMedia('(max-width: 800px)')
		let bodies: Array<LanternOrbBody> = createLanternOrbBodies()
		let last = performance.now()
		let time = 0
		let raf: number | null = null
		let visible = false

		const place = (drift: boolean) => {
			const width = node.getBoundingClientRect().width
			if (width === 0) return
			for (const body of bodies) {
				const home = homes.get(body.id)
				if (!home) continue
				const dx = drift ? (body.x - home.x) * width : 0
				const dy = drift ? (body.y - home.y) * width : 0
				const transform = drift
					? `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0)`
					: ''
				for (const el of node.querySelectorAll<HTMLElement>(
					`[data-orb="${body.id}"], [data-orb-art="${body.id}"]`,
				)) {
					if (transform) el.style.transform = transform
					else el.style.removeProperty('transform')
				}
			}
			node.dispatchEvent(
				new CustomEvent(lanternOrbMotionEvent, { bubbles: true }),
			)
		}

		const tick = (now: number) => {
			raf = null
			if (!motionOk.matches) {
				bodies = createLanternOrbBodies()
				time = 0
				place(false)
				return
			}
			if (!visible || document.visibilityState === 'hidden') return
			const dt = Math.min(0.033, Math.max(0, (now - last) / 1000))
			last = now
			time += dt
			bodies = stepLanternOrbMotion(bodies, dt, {
				time,
				amplitude: narrow.matches ? 0.62 : 1,
			})
			place(true)
			raf = requestAnimationFrame(tick)
		}

		const wake = () => {
			last = performance.now()
			if (raf == null) raf = requestAnimationFrame(tick)
		}

		const observer = new IntersectionObserver(([entry]) => {
			visible = entry?.isIntersecting ?? false
			wake()
		})
		observer.observe(node)
		motionOk.addEventListener('change', wake, { signal })
		narrow.addEventListener('change', wake, { signal })
		document.addEventListener('visibilitychange', wake, { signal })
		signal.addEventListener('abort', () => {
			observer.disconnect()
			if (raf != null) cancelAnimationFrame(raf)
		})
	})
}
