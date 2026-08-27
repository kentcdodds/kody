import { type Handle, ref } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { reveal } from '#client/reveal.ts'
import {
	landingTestimonials,
	shuffleTestimonials,
	testimonialInitials,
	type LandingTestimonial,
} from '#universal/landing-testimonials.ts'

const AUTO_ADVANCE_MS = 7000

/**
 * Homepage testimonials carousel. SSR paints the canonical data order; the
 * client shuffles once after mount so each page load randomizes without a
 * hydration mismatch. Auto-advance pauses on hover/focus and stays off under
 * `prefers-reduced-motion`. Prev/next and dots stay available either way.
 */
export function LandingTestimonialsCarousel(handle: Handle) {
	let items: Array<LandingTestimonial> = [...landingTestimonials]
	let index = 0
	let reducedMotion = false
	let paused = false
	let timer: ReturnType<typeof setTimeout> | null = null
	let shuffled = false

	function clearTimer() {
		if (timer === null) return
		clearTimeout(timer)
		timer = null
	}

	function scheduleAdvance() {
		clearTimer()
		if (reducedMotion || paused || items.length < 2) return
		timer = setTimeout(() => {
			timer = null
			if (handle.signal.aborted || paused || reducedMotion) return
			index = (index + 1) % items.length
			handle.update()
			scheduleAdvance()
		}, AUTO_ADVANCE_MS)
	}

	function setPaused(next: boolean) {
		if (paused === next) return
		paused = next
		if (paused) clearTimer()
		else scheduleAdvance()
	}

	function goTo(nextIndex: number) {
		if (items.length === 0) return
		index = ((nextIndex % items.length) + items.length) % items.length
		handle.update()
		scheduleAdvance()
	}

	handle.signal.addEventListener('abort', clearTimer)

	handle.queueTask(() => {
		if (shuffled || handle.signal.aborted) return
		shuffled = true
		reducedMotion =
			typeof matchMedia === 'function' &&
			matchMedia('(prefers-reduced-motion: reduce)').matches
		items = shuffleTestimonials(landingTestimonials)
		index = 0
		handle.update()
		scheduleAdvance()
	})

	return () => {
		const active = items[index]
		if (!active) return null
		const count = items.length

		return (
			<div
				class="landing-testimonials-carousel"
				aria-roledescription="carousel"
				aria-label="Testimonials"
				mix={[
					reveal(),
					ref((node: Element, signal: AbortSignal) => {
						const el = node as HTMLElement
						const onEnter = () => setPaused(true)
						const onLeave = () => {
							if (el.contains(document.activeElement)) return
							setPaused(false)
						}
						const onFocusIn = () => setPaused(true)
						const onFocusOut = (event: FocusEvent) => {
							const next = event.relatedTarget
							if (next instanceof Node && el.contains(next)) return
							setPaused(false)
						}
						const onKeyDown = (event: KeyboardEvent) => {
							if (event.key === 'ArrowLeft') {
								event.preventDefault()
								goTo(index - 1)
							} else if (event.key === 'ArrowRight') {
								event.preventDefault()
								goTo(index + 1)
							}
						}
						el.addEventListener('pointerenter', onEnter)
						el.addEventListener('pointerleave', onLeave)
						el.addEventListener('focusin', onFocusIn)
						el.addEventListener('focusout', onFocusOut)
						el.addEventListener('keydown', onKeyDown)
						signal.addEventListener('abort', () => {
							el.removeEventListener('pointerenter', onEnter)
							el.removeEventListener('pointerleave', onLeave)
							el.removeEventListener('focusin', onFocusIn)
							el.removeEventListener('focusout', onFocusOut)
							el.removeEventListener('keydown', onKeyDown)
						})
					}),
				]}
			>
				<div class="landing-testimonials-toolbar">
					<button
						type="button"
						class="landing-testimonials-nav"
						aria-label="Previous testimonial"
						mix={on('click', () => goTo(index - 1))}
					>
						<span aria-hidden="true">←</span>
					</button>
					<p class="landing-testimonials-status" aria-live="polite">
						{index + 1} of {count}
					</p>
					<button
						type="button"
						class="landing-testimonials-nav"
						aria-label="Next testimonial"
						mix={on('click', () => goTo(index + 1))}
					>
						<span aria-hidden="true">→</span>
					</button>
				</div>

				<div class="landing-testimonials-viewport">
					<article
						key={`${active.name}-${index}`}
						class="landing-testimonial-card"
						aria-roledescription="slide"
						aria-label={`${index + 1} of ${count}`}
					>
						<blockquote class="landing-testimonial-quote">
							<p>{active.quote}</p>
						</blockquote>
						<footer class="landing-testimonial-person">
							<a
								href={active.href}
								class="landing-testimonial-link"
								target="_blank"
								rel="noopener noreferrer"
							>
								{active.photo ? (
									<img
										src={active.photo}
										alt=""
										width={56}
										height={56}
										class="landing-testimonial-photo"
										decoding="async"
										loading="lazy"
									/>
								) : (
									<span class="landing-testimonial-initials" aria-hidden="true">
										{testimonialInitials(active.name)}
									</span>
								)}
								<span class="landing-testimonial-meta">
									<span class="landing-testimonial-name">{active.name}</span>
									{active.title ? (
										<span class="landing-testimonial-title">
											{active.title}
										</span>
									) : null}
								</span>
							</a>
						</footer>
					</article>
				</div>

				{count > 1 ? (
					<div
						class="landing-testimonials-dots"
						role="tablist"
						aria-label="Choose a testimonial"
					>
						{items.map((item, dotIndex) => (
							<button
								key={item.name}
								type="button"
								role="tab"
								aria-selected={dotIndex === index ? 'true' : 'false'}
								aria-label={`Show testimonial from ${item.name}`}
								class={
									dotIndex === index
										? 'landing-testimonials-dot is-active'
										: 'landing-testimonials-dot'
								}
								mix={on('click', () => goTo(dotIndex))}
							/>
						))}
					</div>
				) : null}
			</div>
		)
	}
}
