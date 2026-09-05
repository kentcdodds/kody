import { createMatcher } from 'remix/route-pattern/match'
import { REMIX_FRAME_TARGET_HEADER } from '#universal/frame-constants.ts'
import { type routes } from '#universal/routes.ts'
import { collectServerTiming } from '#worker/request-context.ts'
import { applyServerTimingHeader } from '#worker/server-timing.ts'

export type FrameRenderContext = {
	request: Request
	env: Env
	url: URL
}

export type FrameRenderer = (
	context: FrameRenderContext,
) => Promise<string> | string

type AppRoute = (typeof routes)[keyof typeof routes]

export type RegisteredFrame = {
	name: string
	/**
	 * Every route the frame may be requested for. More than one is legitimate
	 * when a single page is addressable by several URL shapes (the canonical
	 * `/@owner/kody-id` package URL and the listing-uuid URL it replaced), and
	 * the frame renders the same content for each.
	 */
	routes: ReadonlyArray<AppRoute>
	render: FrameRenderer
}

const framesByName = new Map<string, RegisteredFrame>()
const routeMatchers = new WeakMap<AppRoute, ReturnType<typeof createMatcher>>()

function getMatcherForRoute(route: AppRoute) {
	let matcher = routeMatchers.get(route)
	if (!matcher) {
		matcher = createMatcher(route.pattern)
		routeMatchers.set(route, matcher)
	}
	return matcher
}

export function pathnameMatchesFrameRoute(
	routes: ReadonlyArray<AppRoute>,
	pathname: string,
) {
	const url = new URL(pathname, 'https://kody.local')
	return routes.some((route) => getMatcherForRoute(route).match(url) !== null)
}

/**
 * Registers (or re-registers) a frame renderer under `name`.
 *
 * Re-registration must replace, not throw: under Vite dev the Cloudflare
 * module runner re-evaluates only the invalidated importer chain of a changed
 * file (`frames/*.ts` → `frame-registrations.ts` → `ssr-render.tsx` → worker
 * entry) while modules off that chain — this registry and its map — keep their
 * state. The same frame module therefore legitimately runs again against a map
 * that already holds its name, and the newest `render` must win so HMR serves
 * fresh code. Name uniqueness across frame modules is a static property checked
 * by `frame-registrations.node.test.ts`.
 */
export function registerFrame(
	name: string,
	config: {
		routes: ReadonlyArray<AppRoute>
		render: FrameRenderer
	},
): RegisteredFrame {
	const frame = {
		name,
		routes: config.routes,
		render: config.render,
	} satisfies RegisteredFrame

	framesByName.set(name, frame)
	return frame
}

export function getRegisteredFrame(name: string) {
	return framesByName.get(name)
}

export function listRegisteredFrameNames() {
	return [...framesByName.keys()]
}

export function createFrameHtmlResponse(html: string) {
	return new Response(html, {
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/html; charset=utf-8',
		},
	})
}

export async function handleFrameRequest(
	request: Request,
	env: Env,
	pathname: string,
) {
	const target = request.headers.get(REMIX_FRAME_TARGET_HEADER)
	if (!target) return null

	const frame = getRegisteredFrame(target)
	if (!frame || !pathnameMatchesFrameRoute(frame.routes, pathname)) return null

	const html = await frame.render({
		request,
		env,
		url: new URL(request.url),
	})
	const response = createFrameHtmlResponse(html)
	applyServerTimingHeader(response.headers, collectServerTiming(request))
	return response
}

export async function resolveRegisteredFrameHtml(input: {
	src: string
	target: string | undefined
	request: Request
	env: Env
	pageUrl: URL
	currentFrameSrc?: string | undefined
}) {
	const { src, target, request, env, pageUrl, currentFrameSrc } = input
	if (!target) {
		throw new Error(`SSR frame resolve requires a target (src=${src})`)
	}

	const frame = getRegisteredFrame(target)
	if (!frame) {
		throw new Error(`Unknown frame target: ${target} (src=${src})`)
	}

	const frameUrl = new URL(src, currentFrameSrc ?? pageUrl)
	if (!pathnameMatchesFrameRoute(frame.routes, frameUrl.pathname)) {
		throw new Error(
			`Frame target ${target} is not registered for ${frameUrl.pathname}`,
		)
	}

	return frame.render({ request, env, url: frameUrl })
}
