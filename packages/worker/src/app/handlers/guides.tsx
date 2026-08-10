import { type Action } from 'remix/router'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	getGuideBySlug,
	listGuides,
	toGuideSummary,
} from '#worker/guides/catalog.ts'
import {
	markdownResponse,
	prefersMarkdown,
	withVaryAccept,
} from '#app/markdown-negotiation.ts'
import { type routes } from '#universal/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { jsonResponse } from '#worker/json-response.ts'

function buildGuidesIndexMarkdown(baseUrl: string): string {
	const lines = [
		'# Kody guides',
		'',
		'Official guides for connecting providers and working with Kody',
		'primitives. Each guide is also available as raw markdown at',
		'`/guides/<slug>.md` (or send `Accept: text/markdown` to the HTML URL).',
		'',
	]
	const guides = listGuides()
	const platform = guides.filter((guide) => guide.category === 'platform')
	const provider = guides.filter((guide) => guide.category === 'provider')
	lines.push('## Platform guides', '')
	for (const guide of platform) {
		lines.push(
			`- [${guide.title}](${baseUrl}/guides/${guide.slug}.md) — ${guide.summary}`,
		)
	}
	if (provider.length > 0) {
		lines.push('', '## Provider guides', '')
		for (const guide of provider) {
			lines.push(
				`- [${guide.title}](${baseUrl}/guides/${guide.slug}.md) — ${guide.summary}`,
			)
		}
	}
	lines.push('')
	return lines.join('\n')
}

export function createGuidesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			if (prefersMarkdown(request)) {
				const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
				return markdownResponse(buildGuidesIndexMarkdown(baseUrl))
			}
			return withVaryAccept(
				await renderAppPage({
					request,
					env,
					title: 'Guides',
					loaderData: {
						guides: { ok: true, guides: listGuides().map(toGuideSummary) },
					},
				}),
			)
		},
	} satisfies Action<typeof routes.guides>
}

export function createGuidesApiHandler(_env: Env) {
	return {
		middleware: [],
		async handler() {
			return jsonResponse({
				ok: true,
				guides: listGuides().map(toGuideSummary),
			})
		},
	} satisfies Action<typeof routes.guidesApi>
}

export function createGuidesMarkdownHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
			return markdownResponse(buildGuidesIndexMarkdown(baseUrl))
		},
	} satisfies Action<typeof routes.guidesMarkdown>
}

export function createGuideDetailHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const guide = getGuideBySlug(params.slug)
			if (!guide) {
				if (prefersMarkdown(request)) {
					return markdownResponse('# Guide not found\n', 404)
				}
				return withVaryAccept(
					await renderAppPage({
						request,
						env,
						title: 'Guide not found',
						notFound: true,
						status: 404,
					}),
				)
			}
			if (prefersMarkdown(request)) {
				return markdownResponse(guide.body)
			}
			return withVaryAccept(
				await renderAppPage({
					request,
					env,
					title: guide.title,
					loaderData: {
						guideDetail: {
							ok: true,
							slug: guide.slug,
							id: guide.id,
							title: guide.title,
							summary: guide.summary,
							category: guide.category,
							provider: guide.provider,
							lastVerified: guide.lastVerified,
							body: guide.body,
						},
					},
				}),
			)
		},
	} satisfies Action<typeof routes.guideDetail>
}

export function createGuideDetailApiHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ params }) {
			const guide = getGuideBySlug(params.slug)
			if (!guide) {
				return jsonResponse({ ok: false, error: 'Guide not found.' }, 404)
			}
			return jsonResponse({
				ok: true,
				slug: guide.slug,
				id: guide.id,
				title: guide.title,
				summary: guide.summary,
				category: guide.category,
				provider: guide.provider,
				lastVerified: guide.lastVerified,
				body: guide.body,
			})
		},
	} satisfies Action<typeof routes.guideDetailApi>
}

export function createGuideDetailMarkdownHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ params }) {
			const guide = getGuideBySlug(params.slug)
			if (!guide) {
				return markdownResponse('# Guide not found\n', 404)
			}
			return markdownResponse(guide.body)
		},
	} satisfies Action<typeof routes.guideDetailMarkdown>
}
