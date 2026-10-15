import { type Handle, ref } from 'remix/component'
import {
	resolveWithAgentOrder,
	withAgentHref,
	withAgentIconSrc,
	type WithAgent,
} from '#universal/with-agents.ts'

const hintId = 'landing-agents-hint'

/**
 * Homepage hero row of agent marks, each linking to its `/with/:agent` page.
 * The order is shuffled once on the server (`landingAgentOrder` loader data)
 * so hydrate matches. The real list sits between two aria-hidden copies.
 * Without JavaScript the copies are hidden and the row is a plain
 * horizontal scroller. With JavaScript (`agentMarqueeMotion`) the copies
 * show, the scroll position wraps by one list width so scrolling never
 * ends, the row drifts when motion is allowed and nobody is using it, and
 * the list is a single tab stop with arrow keys between marks. Styles:
 * `.landing-agents` in `public/styles.css`.
 */
export function LandingAgentMarquee(
	handle: Handle<{ order?: ReadonlyArray<string> | null }>,
) {
	return () => {
		const agents = resolveWithAgentOrder(handle.props.order)
		return (
			<nav
				class="landing-agents"
				aria-label="Agents that work with Kody"
				mix={agentMarqueeMotion()}
			>
				<span id={hintId} hidden>
					Use the arrow keys to move between agents.
				</span>
				<ul class="landing-agents-track">
					{agents.map((agent) => renderAgent(agent, 'before'))}
					{agents.map((agent) => renderAgent(agent, null))}
					{agents.map((agent) => renderAgent(agent, 'after'))}
				</ul>
			</nav>
		)
	}
}

function renderAgent(agent: WithAgent, loopCopy: 'before' | 'after' | null) {
	return (
		<li
			key={loopCopy ? `${agent.slug}-${loopCopy}` : agent.slug}
			class="landing-agents-item"
			aria-hidden={loopCopy ? 'true' : undefined}
		>
			<a
				href={withAgentHref(agent.slug)}
				class="landing-agent"
				draggable={false}
				// Real links leave tabindex to the roving focus in
				// `agentMarqueeMotion`; rendering it would reset that on update.
				{...(loopCopy ? { tabIndex: -1 } : {})}
			>
				<span
					class="landing-agent-icon"
					aria-hidden="true"
					style={{ '--agent-icon': `url(${withAgentIconSrc(agent)})` }}
				></span>
				<span class="landing-agent-name">{agent.name}</span>
			</a>
		</li>
	)
}

/** Drift speed in CSS pixels per second. */
const driftSpeed = 28
/** Pause the drift this long after someone scrolls, swipes, or drags. */
const idleAfterUseMs = 2500
/** Pointer travel before a press on a mark becomes a drag instead of a click. */
const dragThreshold = 6

function agentMarqueeMotion() {
	return ref((node: Element, signal: AbortSignal) => {
		if (!(node instanceof HTMLElement)) return
		const list = node.querySelector<HTMLElement>('.landing-agents-track')
		if (!list) return
		const items = [
			...list.querySelectorAll<HTMLElement>('.landing-agents-item'),
		]
		const count = items.length / 3
		if (!Number.isInteger(count) || count === 0) return
		const links = items
			.slice(count, count * 2)
			.map((item) => item.querySelector<HTMLAnchorElement>('.landing-agent'))
			.filter((link): link is HTMLAnchorElement => link != null)
		if (links.length !== count) return

		node.classList.add('is-looping')
		list.setAttribute('aria-describedby', hintId)

		let active = 0
		const setActive = (index: number) => {
			active = index
			links.forEach((link, i) => {
				link.tabIndex = i === index ? 0 : -1
			})
		}
		setActive(0)

		let setWidth = 0
		let pos = 0
		const measure = () => {
			const start = items[count]?.offsetLeft ?? 0
			const end = items[count * 2]?.offsetLeft ?? 0
			const next = end - start
			if (next <= 0) return
			pos = setWidth > 0 ? next + (pos - setWidth) : next
			setWidth = next
		}
		const keyboardFocusInside = () =>
			node.contains(document.activeElement) &&
			document.activeElement?.matches(':focus-visible') === true
		// Keep the view inside the middle third. The copies make the jump
		// invisible. Keyboard focus is on a real mark, so it must stay put.
		const wrap = () => {
			if (setWidth <= 0 || keyboardFocusInside()) return 0
			let shift = 0
			if (pos < setWidth * 0.5) shift = setWidth
			else if (pos >= setWidth * 1.5) shift = -setWidth
			pos += shift
			return shift
		}
		const apply = () => {
			node.scrollLeft = pos
		}

		measure()
		apply()

		let usedUntil = 0
		const markUsed = () => {
			usedUntil = performance.now() + idleAfterUseMs
		}
		let hovering = false
		let pressed = false

		node.addEventListener(
			'scroll',
			() => {
				if (Math.abs(node.scrollLeft - pos) < 1) return
				pos = node.scrollLeft
				if (wrap() !== 0) apply()
			},
			{ signal, passive: true },
		)
		node.addEventListener('wheel', markUsed, { signal, passive: true })
		node.addEventListener('touchstart', markUsed, { signal, passive: true })
		node.addEventListener('touchend', markUsed, { signal, passive: true })
		node.addEventListener(
			'pointerenter',
			(event) => {
				if (event instanceof PointerEvent && event.pointerType === 'mouse') {
					hovering = true
				}
			},
			{ signal },
		)
		node.addEventListener(
			'pointerleave',
			() => {
				hovering = false
			},
			{ signal },
		)

		// Mouse drag scrolls the row. Touch and trackpads scroll natively.
		let drag: {
			id: number
			startX: number
			startPos: number
			moved: boolean
		} | null = null
		let suppressClick = false
		node.addEventListener(
			'pointerdown',
			(event) => {
				if (!(event instanceof PointerEvent)) return
				if (event.pointerType !== 'mouse' || event.button !== 0) return
				drag = {
					id: event.pointerId,
					startX: event.clientX,
					startPos: pos,
					moved: false,
				}
				pressed = true
			},
			{ signal },
		)
		node.addEventListener(
			'pointermove',
			(event) => {
				if (!(event instanceof PointerEvent) || !drag) return
				if (event.pointerId !== drag.id) return
				const dx = event.clientX - drag.startX
				if (!drag.moved) {
					if (Math.abs(dx) < dragThreshold) return
					drag.moved = true
					node.setPointerCapture(drag.id)
					node.classList.add('is-dragging')
				}
				pos = drag.startPos - dx
				drag.startPos += wrap()
				apply()
				markUsed()
			},
			{ signal },
		)
		const endDrag = () => {
			if (drag?.moved) {
				suppressClick = true
				node.classList.remove('is-dragging')
				markUsed()
			}
			drag = null
			pressed = false
		}
		node.addEventListener('pointerup', endDrag, { signal })
		node.addEventListener('pointercancel', endDrag, { signal })
		node.addEventListener(
			'click',
			(event) => {
				if (!suppressClick) return
				suppressClick = false
				event.preventDefault()
				event.stopPropagation()
			},
			{ signal, capture: true },
		)

		const reveal = (link: HTMLElement, jump: boolean) => {
			const item = link.closest<HTMLElement>('.landing-agents-item')
			if (!item) return
			const left =
				item.offsetLeft -
				(items[0]?.offsetLeft ?? 0) -
				(node.clientWidth - item.offsetWidth) / 2
			const smooth = !jump && motionOk.matches
			node.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' })
			if (!smooth) pos = node.scrollLeft
		}
		const centeredIndex = () => {
			const center =
				node.scrollLeft + node.clientWidth / 2 + (items[0]?.offsetLeft ?? 0)
			const hit = items.findIndex(
				(item) =>
					item.offsetLeft <= center &&
					center < item.offsetLeft + item.offsetWidth,
			)
			return hit < 0 ? active : hit % count
		}
		node.addEventListener(
			'focusin',
			(event) => {
				const index = links.indexOf(event.target as HTMLAnchorElement)
				if (index < 0) return
				const from = event.relatedTarget
				const tabbedIn =
					!(from instanceof Node && node.contains(from)) &&
					links[index]?.matches(':focus-visible')
				if (!tabbedIn) {
					if (index !== active) setActive(index)
					return
				}
				// Tabbing in lands on the mark in the middle of the view, not
				// wherever the drift has carried the last active one.
				const target = centeredIndex()
				setActive(target)
				const link = links[target]
				if (!link) return
				if (target !== index) link.focus({ preventScroll: true })
				reveal(link, true)
			},
			{ signal },
		)
		node.addEventListener(
			'keydown',
			(event) => {
				if (!(event instanceof KeyboardEvent)) return
				const index = links.indexOf(event.target as HTMLAnchorElement)
				if (index < 0) return
				let next: number
				switch (event.key) {
					case 'ArrowRight':
						next = (index + 1) % count
						break
					case 'ArrowLeft':
						next = (index - 1 + count) % count
						break
					case 'Home':
						next = 0
						break
					case 'End':
						next = count - 1
						break
					default:
						return
				}
				event.preventDefault()
				const link = links[next]
				if (!link) return
				setActive(next)
				link.focus({ preventScroll: true })
				// Wrapping past either end jumps instantly. The copies on each
				// side make the jump look like one more step.
				reveal(link, Math.abs(next - index) > 1)
			},
			{ signal },
		)

		const motionOk = matchMedia('(prefers-reduced-motion: no-preference)')
		let visible = false
		let raf: number | null = null
		let last = performance.now()
		const drifting = () =>
			visible &&
			motionOk.matches &&
			!hovering &&
			!pressed &&
			!keyboardFocusInside() &&
			performance.now() >= usedUntil
		const tick = (now: number) => {
			raf = null
			const dt = Math.min(0.05, (now - last) / 1000)
			last = now
			if (drifting()) {
				pos += driftSpeed * dt
				wrap()
				apply()
			}
			if (visible && motionOk.matches) raf = requestAnimationFrame(tick)
		}
		const wake = () => {
			last = performance.now()
			if (raf == null && visible && motionOk.matches) {
				raf = requestAnimationFrame(tick)
			}
		}
		const observer = new IntersectionObserver(([entry]) => {
			visible = entry?.isIntersecting ?? false
			wake()
		})
		observer.observe(node)
		const resize = new ResizeObserver(() => {
			measure()
			wrap()
			apply()
		})
		resize.observe(list)
		motionOk.addEventListener('change', wake, { signal })

		signal.addEventListener('abort', () => {
			observer.disconnect()
			resize.disconnect()
			if (raf != null) cancelAnimationFrame(raf)
			node.classList.remove('is-looping', 'is-dragging')
		})
	})
}
