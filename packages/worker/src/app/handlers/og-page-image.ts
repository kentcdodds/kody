import { type Action } from 'remix/router'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { type routes } from '#app/routes.ts'
import { getPublicOgPage } from '#worker/og/pages.ts'

export function createOgPageImageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const page = getPublicOgPage(params.page)
			if (!page) {
				return new Response('Not found', { status: 404 })
			}

			// Lazy import (sanctioned exception to the no-inline-imports rule):
			// the OG renderer pulls in satori and @resvg/resvg-wasm plus two wasm
			// binaries, which would otherwise bloat isolate cold starts for a
			// route that is only hit by social-media crawlers.
			const { renderPageOgImage } = await import('#worker/og/page-image.ts')
			const label = new URL(getAppBaseUrl({ env, requestUrl: request.url }))
				.host
			const png = await renderPageOgImage({ page, label })

			return new Response(png, {
				status: 200,
				headers: {
					'Cache-Control': 'public, max-age=3600',
					'Content-Type': 'image/png',
				},
			})
		},
	} satisfies Action<typeof routes.ogPageImage>
}
