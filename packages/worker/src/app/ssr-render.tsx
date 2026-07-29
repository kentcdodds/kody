/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { renderToStream } from 'remix/ui/server'
import { type RemixNode } from 'remix/ui'
import {
	buildClientEntryHref,
	buildStylesheetHref,
	getClientBuildId,
} from '#app/client-build-id.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import {
	absolutizeDocumentHead,
	resolveDocumentHead,
} from '#app/document-head.ts'
import { getEnv } from '#app/env.ts'
import { type AppLoaderData, getRequestUrl } from '#app/loader-data.ts'
import { getRequestDataCacheLookup } from '#app/request-cache.ts'
import { applyFirstPartySecurityHeaders } from '#app/security-headers.ts'
import { loadSessionInfo } from '#app/session-info.ts'
import { getClientModulePreloadHrefs } from '#app/client-preload-manifest.ts'
import { SsrDocument } from '#app/ssr-document.tsx'
import { preloadClientRouteModules } from '#client/lazy-route.tsx'
import {
	SENTRY_TUNNEL_PATH,
	type SentryClientConfig,
} from '#client/sentry-config.ts'
import '#app/frame-registrations.ts'
import { resolveRegisteredFrameHtml } from '#app/frame-registry.ts'

export type RenderAppPageInput = {
	request: Request
	env: Env
	/** Optional title override (e.g. not-found pages). Defaults to the registry. */
	title?: string
	loaderData?: AppLoaderData
	notFound?: boolean
	status?: number
	extraSetCookies?: Array<string>
}

export async function renderAppPage(input: RenderAppPageInput) {
	const { request, env, title, loaderData, notFound, status, extraSetCookies } =
		input
	// OAuth authorize (and any SSR entry) can run outside appHandler, so configure
	// the session cookie before reading request cookies.
	setAuthSessionSecret(getEnv(env).COOKIE_SECRET)
	const { session, setCookie } = await loadSessionInfo(request, env)
	const requestUrl = new URL(request.url)
	const url = getRequestUrl(request)
	const clientEntryHref = buildClientEntryHref(getClientBuildId(getEnv(env)))
	const stylesheetHref = buildStylesheetHref(getClientBuildId(getEnv(env)))
	const origin = getAppBaseUrl({ env, requestUrl: request.url })
	const documentHead = absolutizeDocumentHead(
		resolveDocumentHead(requestUrl.pathname, loaderData),
		origin,
	)
	if (title !== undefined) {
		documentHead.title = title
	}
	const parsedEnv = getEnv(env)
	const sentryDsn = parsedEnv.SENTRY_DSN?.trim()
	const sentryConfig: SentryClientConfig | null = sentryDsn
		? {
				dsn: sentryDsn,
				environment: parsedEnv.SENTRY_ENVIRONMENT?.trim() || 'development',
				release: parsedEnv.APP_COMMIT_SHA ?? null,
				tunnel: SENTRY_TUNNEL_PATH,
			}
		: null
	const fathomSiteId = parsedEnv.FATHOM_SITE_ID?.trim() || null

	// Warm lazy route chunks before streaming so SSR HTML includes the real
	// route tree (dynamic import resolves in the worker bundle), and resolve
	// the modulepreload hints for those chunks in parallel.
	const [, modulePreloadHrefs] = await Promise.all([
		preloadClientRouteModules(`${requestUrl.pathname}${requestUrl.search}`),
		getClientModulePreloadHrefs({
			assets: env.ASSETS,
			buildId: getClientBuildId(parsedEnv),
			pathname: requestUrl.pathname,
		}),
	])

	const stream = renderToStream(
		// Remix server components accept props via handle.props; JSX typing is loose here.
		(
			<SsrDocument
				documentHead={documentHead}
				url={url}
				session={session}
				loaderData={loaderData}
				notFound={notFound}
				clientEntryHref={clientEntryHref}
				stylesheetHref={stylesheetHref}
				modulePreloadHrefs={modulePreloadHrefs}
				sentryConfig={sentryConfig}
				fathomSiteId={fathomSiteId}
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
