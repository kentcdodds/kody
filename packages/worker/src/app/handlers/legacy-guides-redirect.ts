import { type Action } from 'remix/router'
import { resolveLegacyDocSlug } from '#universal/docs-nav.ts'
import { type routes } from '#universal/routes.ts'

/**
 * The docs lived under `/guides` before they became `/docs`. Every old URL
 * shape keeps resolving with a 308 (method-preserving, cacheable):
 *
 * - `/guides`, `/guides.md`, `/guides.json` → `/docs`, `/docs.md`, `/docs.json`
 * - `/guides/connect(.md|.json)` → `/docs/connect(.md|.json)`
 * - `/guides/:slug`, `:slug.md`, `:slug.json`, `:slug/og.png` → the same
 *   twin under `/docs/`, through `legacyDocSlugAliases` for merged docs.
 *
 * Query strings survive; a merged doc's HTML redirect carries the absorbing
 * heading as a fragment.
 */
export function resolveLegacyGuidesLocation(url: URL): string {
	const { pathname, search } = url
	if (pathname === '/guides') return `/docs${search}`
	if (pathname === '/guides.md') return `/docs.md${search}`
	if (pathname === '/guides.json') return `/docs.json${search}`

	const rest = pathname.startsWith('/guides/')
		? pathname.slice('/guides/'.length)
		: ''
	if (rest === '' || rest.startsWith('connect')) {
		return `/docs${rest ? `/${rest}` : ''}${search}`
	}

	const twinMatch = /^([^/.]+)(\.md|\.json|\/og\.png)?$/.exec(rest)
	if (!twinMatch) return `/docs/${rest}${search}`
	const alias = resolveLegacyDocSlug(twinMatch[1]!)
	const twin = twinMatch[2] ?? ''
	const fragment = twin === '' && alias.fragment ? `#${alias.fragment}` : ''
	return `/docs/${alias.slug}${twin}${search}${fragment}`
}

function redirectResponse(request: Request): Response {
	return new Response(null, {
		status: 308,
		headers: {
			Location: resolveLegacyGuidesLocation(new URL(request.url)),
			'Cache-Control': 'public, max-age=3600',
		},
	})
}

export function createLegacyGuidesRedirectHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return redirectResponse(request)
		},
	} satisfies Action<typeof routes.legacyGuides>
}

export function createLegacyGuidesApiRedirectHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return redirectResponse(request)
		},
	} satisfies Action<typeof routes.legacyGuidesApi>
}

export function createLegacyGuidesMarkdownRedirectHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return redirectResponse(request)
		},
	} satisfies Action<typeof routes.legacyGuidesMarkdown>
}

export function createLegacyGuidesPathRedirectHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			return redirectResponse(request)
		},
	} satisfies Action<typeof routes.legacyGuidesPath>
}
