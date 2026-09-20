import { type Handle, ref } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { docHref } from '#universal/docs-nav.ts'
import {
	landingHomePrimitives,
	landingPrimitivesIntroLead,
	landingPrimitivesMoreLead,
	landingPrimitivesMoreLink,
	type LandingHomePrimitive,
} from '#universal/landing-home-copy.ts'
import {
	landingLeaderOrbAnchor,
	landingLeaderPath,
	landingLeaderSide,
	landingLeaderWordAnchor,
	landingPrimitiveColorVar,
	landingPrimitiveIds,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'
import { LandingLantern } from '#client/routes/landing-lantern.tsx'

/**
 * Homepage primitives row: the five-orb lantern beside the primitives
 * sentence. Each orb and each named word is a disclosure for the same
 * popover: hover, focus, or click opens one; Escape, blur, and leaving close
 * it. Escape does not move focus, so a hovered trigger stays dismissed
 * instead of reopening on focusin. Opening another primitive dismisses the
 * previous one so :hover and :focus-within cannot stack two panels.
 *
 * Leader lines run from each orb to its word. They are measured from layout
 * (orb centre to the word's underline) and redrawn on resize and font load,
 * so they track wrapping. The overlay is `display: none` on narrow screens
 * and the measurement skips while it is hidden. No-JS keeps the definitions
 * in the document for read-out and simply has no lines.
 */

export const landingPrimitivesSectionId = 'primitives'

const whatIsKodyHref = docHref('what-is-kody')

/** Punctuation that follows each word. It stays glued to the word (the
 *  button is an atomic inline, so a bare comma could otherwise wrap onto
 *  the next line); the space after it is the break opportunity. */
function primitiveTail(index: number, count: number) {
	if (index === count - 1) return '.'
	if (index === count - 2) return ', and'
	return ','
}

/** Measure orbs and words, then write the leader paths in section pixels. */
function leaderFollow() {
	return ref((node: Element, signal: AbortSignal) => {
		const svg = node.querySelector<SVGSVGElement>('.landing-primitives-leaders')
		if (!svg) return
		const lead = node.querySelector<HTMLElement>('.landing-primitives-lead')

		const draw = () => {
			if (getComputedStyle(svg).display === 'none') return
			const origin = node.getBoundingClientRect()
			if (origin.width === 0) return
			svg.setAttribute('viewBox', `0 0 ${origin.width} ${origin.height}`)
			for (const id of landingPrimitiveIds) {
				const orb = node.querySelector<HTMLElement>(`[data-orb="${id}"]`)
				const word = node.querySelector<HTMLElement>(`[data-word="${id}"]`)
				const leader = svg.querySelector<SVGGElement>(
					`[data-primitive="${id}"]`,
				)
				if (!orb || !word || !leader) continue
				const wordRect = word.getBoundingClientRect()
				const from = landingLeaderOrbAnchor(orb.getBoundingClientRect(), origin)
				const side = landingLeaderSide(from, {
					top: wordRect.top - origin.top,
					bottom: wordRect.bottom - origin.top,
				})
				const to = landingLeaderWordAnchor(wordRect, origin, side)
				const d = landingLeaderPath(from, to, side)
				for (const path of leader.querySelectorAll('path')) {
					path.setAttribute('d', d)
				}
				const dot = leader.querySelector('circle')
				if (dot) {
					dot.setAttribute('cx', String(to.x))
					dot.setAttribute('cy', String(to.y))
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

		const observer = new ResizeObserver(schedule)
		observer.observe(node)
		if (lead) observer.observe(lead)
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
					<circle class="landing-leader-dot" r="3" />
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

	function panelId(id: LandingPrimitiveId) {
		return `${handle.id}-${id}-panel`
	}

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
			aria-label="Kody primitives"
			class="landing-primitives"
			data-active={openId ?? undefined}
			mix={follow}
		>
			<LandingLantern
				activeId={openId}
				panelId={panelId}
				onOpen={setOpen}
				onToggle={toggle}
				onClose={close}
				onDismiss={dismiss}
				onResume={clearDismissed}
			/>
			{renderLeaders(openId)}
			<div class="landing-primitives-copy">
				<p class="landing-primitives-lead">
					{landingPrimitivesIntroLead}
					{landingHomePrimitives.map((primitive, index) => (
						<span key={primitive.id}>
							<span class="landing-primitive-item">
								<LandingPrimitiveWord
									primitive={primitive}
									panelId={panelId(primitive.id)}
									open={openId === primitive.id}
									dismissed={dismissedId === primitive.id}
									onOpen={() => setOpen(primitive.id)}
									onToggle={() => toggle(primitive.id)}
									onClose={() => close(primitive.id)}
									onDismiss={() => dismiss(primitive.id)}
									onResume={() => clearDismissed(primitive.id)}
								/>
								{primitiveTail(index, landingHomePrimitives.length)}
							</span>
							{index < landingHomePrimitives.length - 1 ? ' ' : null}
						</span>
					))}
				</p>
				<p class="landing-primitives-more">
					{landingPrimitivesMoreLead}{' '}
					<a href={whatIsKodyHref} class="landing-inline-link">
						{landingPrimitivesMoreLink}
					</a>
				</p>
			</div>
		</section>
	)
}

function LandingPrimitiveWord(
	handle: Handle<{
		primitive: LandingHomePrimitive
		panelId: string
		open: boolean
		dismissed: boolean
		onOpen: () => void
		onToggle: () => void
		onClose: () => void
		onDismiss: () => void
		onResume: () => void
	}>,
) {
	function closeIfLeaving(
		current: EventTarget | null,
		next: EventTarget | null,
	) {
		if (!(current instanceof Element)) return
		if (next instanceof Node && current.contains(next)) return
		handle.props.onClose()
		handle.props.onResume()
	}

	return () => {
		const { primitive, panelId, open, dismissed, onOpen } = handle.props
		return (
			<span
				class="landing-primitive"
				data-open={open ? '' : undefined}
				data-dismissed={dismissed ? '' : undefined}
				style={{
					'--primitive-color': landingPrimitiveColorVar(primitive.id),
				}}
				mix={[
					on('mouseenter', onOpen),
					on('mouseleave', (event: MouseEvent) => {
						closeIfLeaving(event.currentTarget, event.relatedTarget)
					}),
					on('focusin', onOpen),
					on('focusout', (event: FocusEvent) => {
						closeIfLeaving(event.currentTarget, event.relatedTarget)
					}),
					ref((node: Element, signal: AbortSignal) => {
						const onKeydown = (event: Event) => {
							if (!(event instanceof KeyboardEvent)) return
							if (event.key !== 'Escape') return
							if (
								!handle.props.open &&
								!node.matches(':hover, :focus-within')
							) {
								return
							}
							event.preventDefault()
							handle.props.onDismiss()
						}
						document.addEventListener('keydown', onKeydown, { signal })
					}),
				]}
			>
				<button
					type="button"
					class="landing-primitive-word"
					data-word={primitive.id}
					aria-expanded={open ? 'true' : 'false'}
					aria-controls={panelId}
					aria-describedby={panelId}
					mix={[
						on('click', () => handle.props.onToggle()),
						on('keydown', (event: KeyboardEvent) => {
							if (event.key !== 'Escape') return
							event.preventDefault()
							handle.props.onDismiss()
						}),
					]}
				>
					{primitive.word}
				</button>
				<span id={panelId} role="tooltip" class="landing-primitive-popover">
					<span class="landing-primitive-popover-title" aria-hidden="true">
						{primitive.word}
					</span>
					{primitive.body}
				</span>
			</span>
		)
	}
}
