/**
 * Arm a below-fold widget once it is near the viewport so third-party
 * scripts stay off the first paint.
 *
 * IntersectionObserver can miss the initial callback on some mobile
 * browsers when the node is already on screen at `observe()` time, so
 * already-near elements arm synchronously from their box.
 */
export function observeNearViewport(
	element: Element,
	onNear: () => void,
	rootMargin = '400px',
): () => void {
	if (typeof IntersectionObserver === 'undefined') {
		onNear()
		return () => {}
	}

	if (isElementNearViewport(element, rootMargin)) {
		onNear()
		return () => {}
	}

	const observer = new IntersectionObserver(
		(entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) {
				return
			}
			observer.disconnect()
			onNear()
		},
		{ root: null, rootMargin, threshold: 0 },
	)
	observer.observe(element)
	return () => {
		observer.disconnect()
	}
}

export function isElementNearViewport(
	element: Element,
	rootMargin = '400px',
): boolean {
	if (typeof window === 'undefined') return false
	if (typeof element.getBoundingClientRect !== 'function') return false
	const margin = Number.parseInt(rootMargin, 10)
	const inset = Number.isFinite(margin) ? margin : 0
	const rect = element.getBoundingClientRect()
	return rect.top < window.innerHeight + inset && rect.bottom > -inset
}
