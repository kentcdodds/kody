import { type Handle, ref } from 'remix/component'
import { routerEvents } from '#client/client-router.tsx'
import { observeNearViewport } from '#client/deferred-turnstile.ts'
import {
	LandingLantern,
	type LandingLanternProps,
} from '#client/routes/landing-lantern.tsx'
import { lantern3dAllowed, whenIdle } from './lantern-3d-gate.ts'
import { type CreateLanternLeaders } from './lantern-3d-leaders.ts'
import {
	type LandingLantern3dLive,
	type LanternStage,
} from './lantern-3d-live.tsx'

/**
 * The primitives lantern in 3D, with the 2D lantern as its poster. The page
 * ships the 2D one, and it stays for no-JS, no WebGL2 in a worker,
 * Save-Data, WebGL without a GPU, a first second too slow to show, and a
 * lost GPU context. Near the viewport, once the page is idle, this loads
 * the 3D lantern's own chunk (`lantern-3d-live.tsx`), which makes those
 * checks, starts the scene, and fades it in over the poster. The poster
 * stays mounted until then, so its orbs keep drifting where the 3D ones
 * start.
 */

export type LandingLantern3dProps = Omit<LandingLanternProps, 'decorative'> & {
	/** The 3D lantern's leader layout, once its chunk has loaded. */
	onLeaders: (create: CreateLanternLeaders) => void
}

export function LandingLantern3d(handle: Handle<LandingLantern3dProps>) {
	let stage: LanternStage = 'poster'
	let posterShown = true
	let Live: typeof LandingLantern3dLive | null = null
	let loadStarted = false
	let navigating = false
	const isNavigating = () => navigating

	if (typeof document !== 'undefined') {
		routerEvents.addEventListener(
			'navigationstart',
			() => {
				navigating = true
			},
			{ signal: handle.signal },
		)
		routerEvents.addEventListener(
			'navigationend',
			() => {
				navigating = false
			},
			{ signal: handle.signal },
		)
	}

	async function load() {
		if (loadStarted || handle.signal.aborted) return
		loadStarted = true
		// Vite folds this to `true` in the server build, which then drops the
		// 3D chunk (and the worker it names) from the Worker bundle.
		if (import.meta.env.SSR) return
		try {
			// Dynamic import is intentional so the 3D lantern stays out of the
			// homepage chunk (sanctioned exception to the no-inline-imports
			// rule). three.js is only in the worker's own bundle.
			const live = await import('./lantern-3d-live.tsx')
			if (handle.signal.aborted) return
			handle.props.onLeaders(live.createLanternLeaders)
			Live = live.LandingLantern3dLive
			void handle.update()
		} catch {
			// The 2D lantern stays.
		}
	}

	function setStage(next: LanternStage, poster: boolean) {
		stage = next
		posterShown = poster
		void handle.update()
	}

	const wrapperRef = ref((node: Element, signal: AbortSignal) => {
		if (!lantern3dAllowed()) return
		const stop = observeNearViewport(node, () => whenIdle(load), '600px')
		signal.addEventListener('abort', stop)
	})

	return () => {
		const { onLeaders: _onLeaders, ...lantern } = handle.props
		return (
			<div class="landing-lantern-3d" data-stage={stage} mix={wrapperRef}>
				{Live ? (
					<Live {...lantern} navigating={isNavigating} onStage={setStage} />
				) : null}
				{posterShown ? (
					<div
						class="landing-lantern-3d-poster"
						inert={stage === 'live' ? true : undefined}
					>
						<LandingLantern {...lantern} />
					</div>
				) : null}
			</div>
		)
	}
}
