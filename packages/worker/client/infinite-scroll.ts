import { ref } from 'remix/ui'

/**
 * Mixin for an infinite-scroll sentinel element rendered at the end of a
 * list. When the sentinel scrolls into view (or near it), `loadMore` runs.
 * `loadMore` must resolve to whether more items were actually loaded —
 * `createInfiniteList().loadMore` already returns exactly that — so an
 * under-filled viewport keeps loading until the sentinel leaves view or
 * there is nothing left, without looping forever once the list is done.
 */
export function infiniteScrollSentinel(
	loadMore: () => Promise<boolean> | boolean,
) {
	return ref((node: Element, signal: AbortSignal) => {
		let running = false
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return
				if (running) return
				running = true
				void (async () => {
					try {
						const loadedMore = await loadMore()
						if (signal.aborted || !loadedMore) return
						// Re-observing delivers a fresh initial notification, so a
						// still-visible sentinel triggers the next page load.
						observer.unobserve(node)
						observer.observe(node)
					} finally {
						running = false
					}
				})()
			},
			{ rootMargin: '200px' },
		)
		observer.observe(node)
		signal.addEventListener('abort', () => observer.disconnect())
	})
}
