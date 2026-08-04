import { ref } from 'remix/ui'

/**
 * Scroll-reveal mixins for the marketing surfaces. The CSS lives in
 * `public/styles.css` (`.reveal`, `.reveal-pop`, `.reveal-card` under
 * `html.js` + `prefers-reduced-motion: no-preference`); these mixins add the
 * class and the stagger delay, then flip `.in` when the element scrolls into
 * view. Enhance-only by construction: without JS the class never lands, so
 * content stays fully visible.
 */

type RevealKind = 'reveal' | 'reveal-pop' | 'reveal-card'

let sharedObserver: IntersectionObserver | null = null

function getObserver() {
	if (!sharedObserver) {
		sharedObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue
					entry.target.classList.add('in')
					sharedObserver?.unobserve(entry.target)
				}
			},
			{ rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
		)
	}
	return sharedObserver
}

function createRevealMixin(kind: RevealKind, delayMs: number) {
	return ref((node: Element, signal: AbortSignal) => {
		if (typeof IntersectionObserver === 'undefined') return
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
		if (delayMs > 0 && node instanceof HTMLElement) {
			node.style.setProperty('--reveal-delay', `${delayMs}ms`)
		}
		node.classList.add(kind)
		const observer = getObserver()
		observer.observe(node)
		signal.addEventListener('abort', () => observer.unobserve(node))
	})
}

/** Quiet rise for illustrations and capability columns (opacity + translate). */
export function reveal(delayMs = 0) {
	return createRevealMixin('reveal', delayMs)
}

/** Small chip pop (opacity + translate + scale) — chips only, never text blocks. */
export function revealPop(delayMs = 0) {
	return createRevealMixin('reveal-pop', delayMs)
}

/**
 * Card entrance as an animation (not a transition) so the card's own hover
 * transitions keep their easing after arrival.
 */
export function revealCard(delayMs = 0) {
	return createRevealMixin('reveal-card', delayMs)
}
