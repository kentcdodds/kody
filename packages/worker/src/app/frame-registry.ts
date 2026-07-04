import { REMIX_FRAME_TARGET_HEADER } from '#app/frame-constants.ts'

export type FrameRenderContext = {
	request: Request
	env: Env
	url: URL
}

export type FrameRenderer = (
	context: FrameRenderContext,
) => Promise<string> | string

export type RegisteredFrame = {
	name: string
	routePathname: string
	render: FrameRenderer
}

const framesByName = new Map<string, RegisteredFrame>()

export function registerFrame(
	name: string,
	config: {
		routePathname: string
		render: FrameRenderer
	},
): RegisteredFrame {
	if (framesByName.has(name)) {
		throw new Error(`Frame name already registered: ${name}`)
	}

	const frame = {
		name,
		routePathname: config.routePathname,
		render: config.render,
	} satisfies RegisteredFrame

	framesByName.set(name, frame)
	return frame
}

export function getRegisteredFrame(name: string) {
	return framesByName.get(name)
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
	routePathname: string,
) {
	const target = request.headers.get(REMIX_FRAME_TARGET_HEADER)
	if (!target) return null

	const frame = getRegisteredFrame(target)
	if (!frame || frame.routePathname !== routePathname) return null

	const html = await frame.render({
		request,
		env,
		url: new URL(request.url),
	})
	return createFrameHtmlResponse(html)
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
	if (frameUrl.pathname !== frame.routePathname) {
		throw new Error(
			`Frame target ${target} is not registered for ${frameUrl.pathname} (expected ${frame.routePathname})`,
		)
	}

	return frame.render({ request, env, url: frameUrl })
}
