/**
 * Arm a below-fold widget once it is near the viewport so third-party
 * scripts stay off the first paint.
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
