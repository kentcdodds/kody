import { type Action } from 'remix/router'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	markdownResponse,
	prefersMarkdown,
	withVaryAccept,
} from '#app/markdown-negotiation.ts'
import { acquisitionPageMeta } from '#universal/acquisition/metadata.ts'
import { acquisitionPages } from '#universal/acquisition/catalog.ts'
import { acquisitionMarkdown } from '#universal/acquisition/markdown.ts'
import { type routes } from '#universal/routes.ts'

export function createAcquisitionHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			if (prefersMarkdown(request)) {
				if (new URL(request.url).pathname === '/use-cases') {
					const index = acquisitionPageMeta.useCases
					return markdownResponse(
						[
							`# ${index.title}`,
							'',
							index.description,
							'',
							...acquisitionPages.map(
								(page) =>
									`- [${page.title}](${page.path}): ${page.description}`,
							),
						].join('\n'),
					)
				}

				const page = acquisitionPages.find(
					(entry) => entry.path === new URL(request.url).pathname,
				)
				if (!page) return markdownResponse('Page not found', 404)
				return markdownResponse(acquisitionMarkdown(page))
			}
			return withVaryAccept(await renderAppPage({ request, env }))
		},
	} satisfies Action<typeof routes.automation>
}
