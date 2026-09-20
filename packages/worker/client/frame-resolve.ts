import { type ResolveFrameOptions } from 'remix/ui'
import { isBrowserFetchNetworkError } from '#client/browser-fetch-network-error.ts'
import { consumePrefetchedFrame } from '#client/frame-prefetch.ts'
import {
	frameFetchUrl,
	isFullHtmlDocumentPrefix,
	REMIX_FRAME_TARGET_HEADER,
} from '#universal/frame-constants.ts'

const safeFrameMethods = new Set(['GET', 'HEAD'])

/** Wrap prefetched HTML so `resolveFrame` always returns a `Response`. */
export function prefetchedFrameResponse(html: string) {
	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	})
}

/**
 * Build the `fetch` init for a frame resolve. GET/HEAD never carry a body —
 * Remix form `method` is lowercase (`get`), and a GET body throws in fetch.
 */
export function createFrameResolveInit(options?: ResolveFrameOptions) {
	const headers = new Headers({ Accept: 'text/html' })
	if (options?.target) {
		headers.set(REMIX_FRAME_TARGET_HEADER, options.target)
	}
	// `no-store` keeps the browser HTTP cache from replaying a document that
	// was stored for the same URL under a different frame header.
	const init: RequestInit = {
		headers,
		signal: options?.signal,
		cache: 'no-store',
	}
	const method = options?.method?.trim()
	if (method) {
		init.method = method
	}
	const formData = options?.formData
	if (method && !isSafeFrameMethod(method) && formData) {
		init.body = encodeFrameFormBody(formData, options?.encType)
	}
	return init
}

/**
 * Fetch a Remix frame document. Idempotent GET/HEAD retries once on browser
 * `fetch` network TypeErrors (WebKit "Load failed", Chromium "Failed to
 * fetch" / "Failed to fetch (host)", Firefox NetworkError) — KODY-CLOUDFLARE-5Y
 * / KODY-6A Mobile Safari and Chrome Mobile blips after the same URL already
 * succeeded.
 */
export async function fetchFrameResolve(
	src: string,
	options?: ResolveFrameOptions,
) {
	const init = createFrameResolveInit(options)
	const url = frameFetchUrl(src, options?.target)
	try {
		return await fetch(url, init)
	} catch (error: unknown) {
		if (
			!isBrowserFetchNetworkError(error) ||
			!isSafeFrameMethod(init.method ?? 'GET')
		) {
			throw error
		}
		return await fetch(url, init)
	}
}

/**
 * Mirror Remix's default `resolveFrame` acceptance: HTML with any status
 * below 500 renders in the frame (validation and not-found pages included);
 * 5xx and non-HTML 3xx/4xx responses throw.
 */
export function assertRenderableFrameResponse(
	response: Response,
	src: string,
	target?: string,
) {
	const isHtml = response.headers
		.get('Content-Type')
		?.toLowerCase()
		.includes('text/html')
	if (response.status >= 500 || (response.status >= 300 && !isHtml)) {
		throw new Error(
			`Frame resolve failed (${response.status}) for ${src}${target ? ` target=${target}` : ''}`,
		)
	}
	return response
}

/**
 * Named-frame reloads must be fragments. A cached document (`<!doctype` /
 * `<html>`) inserted into that frame redraws the whole shell, and that shell
 * contains the same frame, so the copies recurse.
 *
 * Document soft-navigations reload the top frame with no name, so `target` is
 * omitted. A full document is the page itself and must not throw (KODY-7Y).
 */
function rejectCachedDocumentHtml(html: string, src: string, target?: string) {
	if (!target || !isFullHtmlDocumentPrefix(html)) return
	throw new Error(
		`Frame resolve received a cached document for ${src} target=${target}`,
	)
}

export async function rejectCachedDocumentFrameResponse(
	response: Response,
	src: string,
	target?: string,
) {
	if (!target) return response
	const prefix = await readResponsePrefix(response)
	rejectCachedDocumentHtml(prefix, src, target)
	return response
}

/**
 * Client `resolveFrame`. Prefetch hits skip the network; otherwise the fetch
 * uses `__frame` + `no-store` when `target` is set.
 */
export async function resolveClientFrame(
	src: string,
	options?: ResolveFrameOptions,
	consumePrefetch: (
		src: string,
		target: string | undefined,
	) => string | undefined = consumePrefetchedFrame,
) {
	const target = options?.target
	const method = options?.method?.trim().toUpperCase()
	const cached = method === 'HEAD' ? undefined : consumePrefetch(src, target)
	if (cached !== undefined) {
		rejectCachedDocumentHtml(cached, src, target)
		return prefetchedFrameResponse(cached)
	}
	const response = await fetchFrameResolve(src, options)
	return rejectCachedDocumentFrameResponse(
		assertRenderableFrameResponse(response, src, target),
		src,
		target,
	)
}

async function readResponsePrefix(response: Response) {
	// Read the clone to completion. Cancelling a one-shot reader hangs in
	// Node's fetch implementation, and frame bodies are small fragments.
	const text = await response.clone().text()
	return text.slice(0, 64)
}

function isSafeFrameMethod(method: string) {
	return safeFrameMethods.has(method.toUpperCase())
}

function encodeFrameFormBody(formData: FormData, encType?: string) {
	if (encType !== 'application/x-www-form-urlencoded') {
		return formData
	}
	const body = new URLSearchParams()
	for (const [name, value] of formData) {
		body.append(name, typeof value === 'string' ? value : value.name)
	}
	return body
}
