import { type Handle, ref } from 'remix/component'
import {
	landingHomePrimitives,
	landingPrimitivesIntroLead,
	landingPrimitivesMoreLead,
	landingPrimitivesMoreLink,
} from '#universal/landing-home-copy.ts'
import {
	landingLanternGlass,
	landingLeaderOrbAnchor,
	landingLeaderOrbExit,
	landingLeaderPath,
	landingLeaderWordAnchor,
	landingPrimitiveColorVar,
	landingPrimitiveIds,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'
import { LandingLantern } from '#client/routes/landing-lantern.tsx'
import { lanternOrbMotionEvent } from '#client/routes/landing-lantern-motion.ts'

/**
 * Homepage primitives block: the locked intro line, then the five-orb
 * lantern with the six words listed beside it, then the learn-more line.
 * Orbs highlight a primitive and draw leader lines to its word; each word
 * links to that primitive's feature page.
 *
 * Leader lines run from each orb to the colored dot before its word. They
 * are measured from layout and redrawn on resize and font load, so they
 * track wrapping. The overlay is `display: none` on narrow screens
 * and the measurement skips while it is hidden. No-JS keeps the definitions
 * in the document for read-out and simply has no lines.
 */

export const landingPrimitivesSectionId = 'primitives'

/** Measure orbs and words, then write the leader paths in section pixels. */
function leaderFollow() {
	return ref((node: Element, signal: AbortSignal) => {
		const svg = node.querySelector<SVGSVGElement>('.landing-primitives-leaders')
		const stage = node.querySelector<HTMLElement>('.landing-primitives-stage')
		if (!svg || !stage) return
		const words = node.querySelector<HTMLElement>('.landing-primitives-words')
		const lanternArt = node.querySelector<HTMLElement>('.landing-lantern-art')

		const draw = () => {
			if (getComputedStyle(svg).display === 'none') return
			const origin = stage.getBoundingClientRect()
			if (origin.width === 0) return
			svg.setAttribute('viewBox', `0 0 ${origin.width} ${origin.height}`)
			if (lanternArt) {
				// Lines run faint inside the glass and come up to full strength
				// as they leave it (see the mask in styles.css).
				const art = lanternArt.getBoundingClientRect()
				svg.style.setProperty(
					'--glass-x',
					`${art.left - origin.left + art.width * landingLanternGlass.x}px`,
				)
				svg.style.setProperty(
					'--glass-y',
					`${art.top - origin.top + art.height * landingLanternGlass.y}px`,
				)
				svg.style.setProperty(
					'--glass-r',
					`${art.width * landingLanternGlass.r}px`,
				)
			}
			for (const id of landingPrimitiveIds) {
				const orb = node.querySelector<HTMLElement>(`[data-orb="${id}"]`)
				const dot = node.querySelector<HTMLElement>(`[data-dot="${id}"]`)
				const leader = svg.querySelector<SVGGElement>(
					`[data-primitive="${id}"]`,
				)
				if (!orb || !dot || !leader) continue
				const orbRect = orb.getBoundingClientRect()
				const centre = landingLeaderOrbAnchor(orbRect, origin)
				const to = landingLeaderWordAnchor(dot.getBoundingClientRect(), origin)
				const from = landingLeaderOrbExit(centre, to, orbRect.width / 2)
				const d = landingLeaderPath(from, to)
				for (const path of leader.querySelectorAll('path')) {
					path.setAttribute('d', d)
				}
			}
			svg.dataset.ready = ''
		}

		let frame: number | null = null
		const schedule = () => {
			if (frame != null) return
			frame = requestAnimationFrame(() => {
				frame = null
				draw()
			})
		}

		// Same frame as the orb step, so the leaders meet the moving rims.
		node.addEventListener(lanternOrbMotionEvent, draw, { signal })

		const observer = new ResizeObserver(schedule)
		observer.observe(stage)
		if (words) observer.observe(words)
		window.addEventListener('resize', schedule, { signal })
		const narrow = matchMedia('(max-width: 800px)')
		narrow.addEventListener('change', schedule, { signal })
		document.fonts?.ready.then(schedule).catch(() => {})
		schedule()
		signal.addEventListener('abort', () => {
			observer.disconnect()
			if (frame != null) cancelAnimationFrame(frame)
		})
	})
}

function renderLeaders(activeId: LandingPrimitiveId | null) {
	return (
		<svg
			class="landing-primitives-leaders"
			aria-hidden="true"
			focusable={false}
			preserveAspectRatio="none"
		>
			{landingPrimitiveIds.map((id) => (
				<g
					key={id}
					class="landing-leader"
					data-primitive={id}
					data-open={activeId === id ? '' : undefined}
					style={{ '--primitive-color': landingPrimitiveColorVar(id) }}
				>
					<path class="landing-leader-halo" fill="none" />
					<path class="landing-leader-base" fill="none" />
					<path class="landing-leader-flow" fill="none" />
				</g>
			))}
		</svg>
	)
}

/** A click that lands this soon after hover or focus opened the same
 *  primitive is the same gesture (tap: focus then click), not a toggle. */
const toggleGraceMs = 400

export function LandingPrimitives(handle: Handle) {
	let openId: LandingPrimitiveId | null = null
	let dismissedId: LandingPrimitiveId | null = null
	let openedAt = 0
	const follow = leaderFollow()

	function setOpen(id: LandingPrimitiveId | null) {
		if (openId === id) return
		if (id) {
			if (openId && openId !== id) dismissedId = openId
			if (dismissedId === id) dismissedId = null
		}
		openId = id
		if (id) openedAt = performance.now()
		handle.update()
	}

	/** Click: open, or close again when it was already open for a while.
	 *  This is the touch path where no hover exists and focus may not fire. */
	function toggle(id: LandingPrimitiveId) {
		if (openId === id && performance.now() - openedAt > toggleGraceMs) {
			dismiss(id)
			return
		}
		setOpen(id)
	}

	function close(id: LandingPrimitiveId) {
		if (openId === id) setOpen(null)
	}

	function dismiss(id: LandingPrimitiveId) {
		if (openId === id) openId = null
		dismissedId = id
		handle.update()
	}

	function clearDismissed(id: LandingPrimitiveId) {
		if (dismissedId !== id) return
		dismissedId = null
		handle.update()
	}

	return () => (
		<section
			id={landingPrimitivesSectionId}
			aria-labelledby="primitives-title"
			class="landing-primitives"
			data-active={openId ?? undefined}
			mix={follow}
		>
			<h2 id="primitives-title" class="landing-primitives-lead">
				{landingPrimitivesIntroLead}
			</h2>
			<div class="landing-primitives-stage">
				<LandingLantern
					activeId={openId}
					onOpen={setOpen}
					onToggle={toggle}
					onClose={close}
					onDismiss={dismiss}
					onResume={clearDismissed}
				/>
				{renderLeaders(openId)}
				<ul class="landing-primitives-words" aria-label="The six primitives">
					{landingHomePrimitives.map((primitive) => (
						<li key={primitive.id} class="landing-primitive-item">
							<LandingPrimitiveWord
								primitive={primitive}
								highlighted={openId === primitive.id}
							/>
						</li>
					))}
				</ul>
			</div>
			<p class="landing-primitives-more">
				{landingPrimitivesMoreLead}{' '}
				<a href="/features" class="landing-inline-link">
					{landingPrimitivesMoreLink}
				</a>
			</p>
		</section>
	)
}

function LandingPrimitiveWord(
	handle: Handle<{
		primitive: (typeof landingHomePrimitives)[number]
		highlighted: boolean
	}>,
) {
	return () => {
		const { primitive, highlighted } = handle.props
		return (
			<span
				class="landing-primitive"
				data-open={highlighted ? '' : undefined}
				style={{
					'--primitive-color': landingPrimitiveColorVar(primitive.id),
				}}
			>
				<span
					class="landing-primitive-dot"
					data-dot={primitive.id}
					aria-hidden="true"
				></span>
				<a
					href={`/features/${primitive.id}`}
					class="landing-primitive-word"
					data-word={primitive.id}
				>
					{primitive.word}
				</a>
			</span>
		)
	}
}
