/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { renderToStream } from 'remix/ui/server'
import { type RemixNode } from 'remix/ui'
import { type AppLoaderData, getRequestUrl } from '#app/loader-data.ts'
import { applyFirstPartySecurityHeaders } from '#app/security-headers.ts'
import { loadSessionInfo } from '#app/session-info.ts'
import { SsrDocument } from '#app/ssr-document.tsx'

export type RenderAppPageInput = {
	request: Request
	env: Env
	title?: string
	extraHead?: RemixNode
	loaderData?: AppLoaderData
	notFound?: boolean
	status?: number
}

export async function renderAppPage(input: RenderAppPageInput) {
	const { request, env, title, extraHead, loaderData, notFound, status } = input
	const { session, setCookie } = await loadSessionInfo(request, env)
	const url = getRequestUrl(request)

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
			/>
		) as RemixNode,
		{
			frameSrc: request.url,
			onError(error) {
				console.error('SSR render error:', error)
			},
		},
	)

	const headers = new Headers({
		'Content-Type': 'text/html; charset=utf-8',
	})
	if (setCookie) {
		headers.append('Set-Cookie', setCookie)
	}

	return applyFirstPartySecurityHeaders(
		new Response(stream, {
			status: status ?? 200,
			headers,
		}),
	)
}
