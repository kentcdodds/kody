/**
 * Run work after the window `load` event so it does not contend with
 * first paint. Already-complete documents run the callback immediately.
 */
export function whenWindowLoaded(
	onLoad: () => void,
	signal?: AbortSignal,
): () => void {
	if (typeof document === 'undefined' || signal?.aborted) {
		return () => {}
	}
	if (document.readyState === 'complete') {
		onLoad()
		return () => {}
	}
	window.addEventListener(
		'load',
		onLoad,
		signal ? { once: true, signal } : { once: true },
	)
	return () => {
		window.removeEventListener('load', onLoad)
	}
}
