import { REMIX_FRAME_TARGET_HEADER } from '#universal/frame-constants.ts'

type FrameCacheKey = string

function makeCacheKey(src: string, target: string | undefined): FrameCacheKey {
	return `${src}\0${target ?? ''}`
}

const frameCache = new Map<FrameCacheKey, string>()

/** Clears all prefetched frame HTML. Called at the start of each prefetch. */
export function clearPrefetchedFrames(): void {
	frameCache.clear()
}

/**
 * Prefetches frame HTML for `resolveFrame`. Failures are silent; a miss falls
 * back to a normal fetch. Each prefetch clears the cache first so stale HTML
 * from a prior navigation cannot be consumed.
 */
export async function prefetchFrame(
	src: string,
	target: string | undefined,
	signal: AbortSignal,
): Promise<void> {
	clearPrefetchedFrames()
	try {
		const headers = new Headers({ Accept: 'text/html' })
		if (target) {
			headers.set(REMIX_FRAME_TARGET_HEADER, target)
		}
		const response = await fetch(src, { headers, signal })
		if (signal.aborted) return
		if (!response.ok) return
		const text = await response.text()
		if (signal.aborted) return
		frameCache.set(makeCacheKey(src, target), text)
	} catch {
		// Prefetch failures degrade to the normal resolveFrame fetch.
	}
}

/** Returns cached frame HTML for an exact `src` + `target` match, then deletes it. */
export function consumePrefetchedFrame(
	src: string,
	target: string | undefined,
): string | undefined {
	const key = makeCacheKey(src, target)
	const html = frameCache.get(key)
	if (html === undefined) return undefined
	frameCache.delete(key)
	return html
}
