/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { renderToStream } from 'remix/ui/server'
import { type RemixNode } from 'remix/ui'
import {
	buildClientEntryHref,
	buildStylesheetHref,
	getClientBuildId,
} from '#app/client-build-id.ts'
import { getEnv } from '#app/env.ts'
import { type AppLoaderData, getRequestUrl } from '#app/loader-data.ts'
import { getRequestDataCacheLookup } from '#app/request-cache.ts'
import { applyFirstPartySecurityHeaders } from '#app/security-headers.ts'
import { loadSessionInfo } from '#app/session-info.ts'
import { SsrDocument } from '#app/ssr-document.tsx'
import '#app/frame-registrations.ts'
import { resolveRegisteredFrameHtml } from '#app/frame-registry.ts'

export type RenderAppPageInput = {
	request: Request
	env: Env
	title?: string
	extraHead?: RemixNode
	loaderData?: AppLoaderData
	notFound?: boolean
	status?: number
	extraSetCookies?: Array<string>
}

export async function renderAppPage(input: RenderAppPageInput) {
	const {
		request,
		env,
		title,
		extraHead,
		loaderData,
		notFound,
		status,
		extraSetCookies,
	} = input
	const { session, setCookie } = await loadSessionInfo(request, env)
	const requestUrl = new URL(request.url)
	const url = getRequestUrl(request)
	const clientEntryHref = buildClientEntryHref(getClientBuildId(getEnv(env)))
	const stylesheetHref = buildStylesheetHref(getClientBuildId(getEnv(env)))

	const stream = renderToStream(
		// Remix server components accept props via handle.props; JSX typing is loose here.
		(
			<SsrDocument
				title={title}
				extraHead={extraHead}
				url={url}
				session={session}
				loaderData={loaderData}
				notFound={notFound}
				clientEntryHref={clientEntryHref}
				stylesheetHref={stylesheetHref}
			/>
		) as RemixNode,
		{
			frameSrc: request.url,
			resolveFrame(src, target, context) {
				return resolveRegisteredFrameHtml({
					src,
					target,
					request,
					env,
					pageUrl: requestUrl,
					currentFrameSrc: context?.currentFrameSrc,
				})
			},
			onError(error) {
				console.error('SSR render error:', error)
			},
		},
	)

	const headers = new Headers({
		'Cache-Control': 'no-store',
		'Content-Type': 'text/html; charset=utf-8',
	})
	if (setCookie) {
		headers.append('Set-Cookie', setCookie)
	}
	for (const cookie of extraSetCookies ?? []) {
		headers.append('Set-Cookie', cookie)
	}
	const cacheLookup = getRequestDataCacheLookup(request)
	if (cacheLookup) {
		headers.set('X-Kody-Cache', cacheLookup)
	}

	return applyFirstPartySecurityHeaders(
		new Response(stream, {
			status: status ?? 200,
			headers,
		}),
	)
}
