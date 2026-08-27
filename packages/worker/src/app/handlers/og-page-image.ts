import { type Action } from 'remix/router'
import { type routes } from '#universal/routes.ts'
import { getPublicOgPage } from '#universal/og-pages.ts'
import { parseOgTheme } from '#worker/og/palette.ts'

export function createOgPageImageHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const page = getPublicOgPage(params.page)
			if (!page) {
				return new Response('Not found', { status: 404 })
			}

			// `?theme=light` renders the pale variant; anything else falls back to
			// the default rather than erroring, since crawlers own these URLs.
			const theme = parseOgTheme(new URL(request.url).searchParams.get('theme'))

			// Lazy import (sanctioned exception to the no-inline-imports rule):
			// the OG renderer pulls in satori and @resvg/resvg-wasm plus two wasm
			// binaries, which would otherwise bloat isolate cold starts for a
			// route that is only hit by social-media crawlers.
			const { renderPageOgImage } = await import('#worker/og/page-image.ts')
			const png = await renderPageOgImage({ page, theme, assets: env.ASSETS })

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
