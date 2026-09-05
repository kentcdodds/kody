/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { renderToStream } from 'remix/ui/server'
import { type RemixNode } from 'remix/ui'
import { buildStylesheetHref, getClientBuildId } from '#app/client-build-id.ts'
import { getClientEntryAssets } from '#app/client-entry-assets.ts'
import { getCanonicalAppBaseUrl } from '#worker/app-base-url.ts'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import {
	absolutizeDocumentHead,
	resolveDocumentHead,
} from '#universal/document-head.ts'
import { getEnv } from '#app/env.ts'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { getRequestDataCacheLookup } from '#app/request-cache.ts'
import { resolveAppPageCacheControl } from '#app/anonymous-html-cache.ts'
import { applyFirstPartySecurityHeaders } from '#app/security-headers.ts'
import { loadSessionInfo } from '#app/session-info.ts'
import { getInlineStylesheet } from '#app/inline-stylesheet.ts'
import { SsrDocument } from '#app/ssr-document.tsx'
import { openDocumentStream } from '#app/ssr-document-stream.ts'
import { preloadClientRouteModules } from '#client/lazy-route.tsx'
import {
	SENTRY_TUNNEL_PATH,
	type SentryClientConfig,
} from '#universal/sentry-config.ts'
import '#app/frame-registrations.ts'
import { resolveRegisteredFrameHtml } from '#app/frame-registry.ts'
import { collectServerTiming } from '#worker/request-context.ts'
import {
	applyServerTimingHeader,
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'

/**
 * Maps a Remix `clientEntry` id onto the public Vite client module.
 * Production SSR often leaves `import.meta.url` empty, so the entry id is
 * `/client-entry.js#AppRoot` while the script tag is `/assets/entry-*.js`.
 * Without this hook, `#rmx-data` tells the browser to import the deleted
 * esbuild path and hydration 404s.
 *
 * Only the app root lives in that entry bundle. Any other island — Pitlane's
 * dev `<HMR />`, whose id is its own dev-server URL — must be imported from
 * the module it names; routed through the entry it fails with "Unknown client
 * export", the island never hydrates, and server-data revalidation is dead.
 */
export function resolveOriginClientEntry({
	entryId,
	href,
	preloads,
}: {
	entryId: string
	href: string
	preloads: Array<string>
}) {
	const [moduleUrl = '', rawExportName] = entryId.split('#')
	const exportName = rawExportName?.trim() || 'AppRoot'
	if (exportName !== 'AppRoot' && moduleUrl.startsWith('/')) {
		return { href: moduleUrl, exportName, preloads: [] }
	}
	return { href, exportName, preloads }
}

export type RenderAppPageInput = {
	request: Request
	env: Env
	/** Optional title override (e.g. not-found pages). Defaults to the registry. */
	title?: string
	loaderData?: AppLoaderData
	notFound?: boolean
	unauthorized?: boolean
	status?: number
	extraSetCookies?: Array<string>
	/** Loader phases already recorded for this request; session + ssr append. */
	serverTiming?: Array<ServerTimingEntry>
}

export async function renderAppPage(input: RenderAppPageInput) {
	const {
		request,
		env,
		title,
		loaderData,
		notFound,
		unauthorized,
		status,
		extraSetCookies,
	} = input
	const serverTiming = input.serverTiming ?? []
	// OAuth authorize (and any SSR entry) can run outside appHandler, so configure
	// the session cookie before reading request cookies.
	setAuthSessionSecret(getEnv(env).COOKIE_SECRET)
	const { session, setCookie } = await pushServerTiming(
		serverTiming,
		'session',
		() => loadSessionInfo(request, env),
	)
	const requestUrl = new URL(request.url)
	const url = `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`
	const clientAssets = getClientEntryAssets(requestUrl.pathname)
	const clientEntryHref = clientAssets.entry ?? '/client-entry.js'
	const stylesheetHref = buildStylesheetHref(getClientBuildId(getEnv(env)))
	// Canonical/OG head URLs use the configured canonical origin so pages
	// dual-served from a legacy host still point crawlers at the canonical
	// domain; everything request-scoped keeps using getAppBaseUrl.
	const origin = getCanonicalAppBaseUrl({ env, requestUrl: request.url })
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

	const response = await pushServerTiming(serverTiming, 'ssr', async () => {
		// Warm lazy route chunks before streaming so SSR HTML includes the real
		// route tree (dynamic import resolves in the worker bundle), and resolve
		// the modulepreload hints and inline stylesheet in parallel.
		const [, inlineStylesheet] = await Promise.all([
			preloadClientRouteModules(`${requestUrl.pathname}${requestUrl.search}`),
			getInlineStylesheet({
				assets: env.ASSETS,
				buildId: getClientBuildId(parsedEnv),
			}),
		])
		const modulePreloadHrefs = clientAssets.js.map((asset) => asset.href)

		const stream = renderToStream(
			// Remix server components accept props via handle.props; JSX typing is loose here.
			(
				<SsrDocument
					documentHead={documentHead}
					canonicalOrigin={origin}
					url={url}
					session={session}
					loaderData={loaderData}
					notFound={notFound}
					unauthorized={unauthorized}
					clientEntryHref={clientEntryHref}
					stylesheetHref={stylesheetHref}
					modulePreloadHrefs={modulePreloadHrefs}
					inlineStylesheet={inlineStylesheet}
					sentryConfig={sentryConfig}
					fathomSiteId={fathomSiteId}
				/>
			) as RemixNode,
			{
				frameSrc: request.url,
				resolveClientEntry(entryId) {
					return resolveOriginClientEntry({
						entryId,
						href: clientEntryHref,
						preloads: modulePreloadHrefs,
					})
				},
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
		// Throws when the render fails before producing the document; the
		// handler's catch then answers with a 500 instead of a truncated 200.
		const body = await openDocumentStream(stream)

		const responseSetsCookie =
			Boolean(setCookie) || (extraSetCookies?.length ?? 0) > 0
		const pageCache = resolveAppPageCacheControl({
			pathname: requestUrl.pathname,
			session,
			request,
			responseSetsCookie,
			status: status ?? 200,
			localDev: parsedEnv.WRANGLER_IS_LOCAL_DEV === 'true',
		})
		const headers = new Headers({
			'Cache-Control': pageCache.cacheControl,
			'Content-Type': 'text/html; charset=utf-8',
		})
		if (pageCache.vary) {
			headers.set('Vary', pageCache.vary)
		}
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
			new Response(body, {
				status: status ?? 200,
				headers,
			}),
		)
	})
	applyServerTimingHeader(
		response.headers,
		collectServerTiming(request, serverTiming),
	)
	return response
}
