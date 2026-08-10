import { type Action } from 'remix/router'
import { getPlatformOauthAppLogoObject } from '#worker/integrations/platform-app-logo.ts'
import { getPlatformOauthAppBySlug } from '#worker/integrations/platform-apps.ts'
import { type routes } from '#universal/routes.ts'

/**
 * Public serving route for operator-uploaded platform-app logos. Assets are
 * content-hashed raster images (SVG uploads are rasterized before storage),
 * served immutable; the `?v=` tag in generated paths busts caches on upload.
 */
export function createIntegrationLogoHandler(env: Env) {
	return {
		middleware: [],
		async handler({ params }) {
			// Disabled apps keep serving their logo: existing connections still
			// render on account pages after an operator disables new connects.
			const app = await getPlatformOauthAppBySlug({
				db: env.APP_DB,
				slug: params.integrationSlug,
				includeDisabled: true,
			})
			if (!app?.logoKey) {
				return new Response('Not found', { status: 404 })
			}
			const object = await getPlatformOauthAppLogoObject({
				env,
				logoKey: app.logoKey,
			})
			if (!object) {
				return new Response('Not found', { status: 404 })
			}
			return new Response(object.body, {
				headers: {
					'Cache-Control': 'public, max-age=31536000, immutable',
					'Content-Length': String(object.size),
					'Content-Type': app.logoContentType ?? 'application/octet-stream',
					ETag: object.httpEtag,
					'X-Content-Type-Options': 'nosniff',
				},
			})
		},
	} satisfies Action<typeof routes.integrationLogo>
}
