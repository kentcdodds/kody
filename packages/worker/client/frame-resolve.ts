import { type ResolveFrameOptions } from 'remix/ui'
import { REMIX_FRAME_TARGET_HEADER } from '#universal/frame-constants.ts'

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
	const init: RequestInit = { headers, signal: options?.signal }
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
