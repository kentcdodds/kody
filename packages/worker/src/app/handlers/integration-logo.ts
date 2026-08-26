import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getPlatformOauthAppLogoObject } from '#worker/integrations/platform-app-logo.ts'
import { getPlatformOauthAppBySlug } from '#worker/integrations/platform-apps.ts'
import { getOauthApp } from '#worker/integrations/service.ts'
import { getUserOauthAppLogoObject } from '#worker/integrations/user-oauth-app-logo.ts'
import { type routes } from '#universal/routes.ts'

/**
 * Serving route for provider logos. Platform (operator) assets are public.
 * User-lane assets require a signed-in session and resolve the caller's app
 * after a platform miss so `/integrations/logos/:slug` stays one URL.
 */
export function createIntegrationLogoHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			// Disabled apps keep serving their logo: existing connections still
			// render on account pages after an operator disables new connects.
			const platformApp = await getPlatformOauthAppBySlug({
				db: env.APP_DB,
				slug: params.integrationSlug,
				includeDisabled: true,
			})
			if (platformApp?.logoKey) {
				const object = await getPlatformOauthAppLogoObject({
					env,
					logoKey: platformApp.logoKey,
				})
				if (object) {
					return logoResponse(object, {
						contentType: platformApp.logoContentType,
						cacheControl: 'public, max-age=31536000, immutable',
					})
				}
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return new Response('Not found', { status: 404 })
			}
			const app = await getOauthApp({
				env,
				userId: user.mcpUser.userId,
				slug: params.integrationSlug,
			})
			if (!app?.logoKey) {
				return new Response('Not found', { status: 404 })
			}
			const object = await getUserOauthAppLogoObject({
				env,
				logoKey: app.logoKey,
			})
			if (!object) {
				return new Response('Not found', { status: 404 })
			}
			return logoResponse(object, {
				contentType: app.logoContentType,
				cacheControl: 'private, max-age=31536000, immutable',
			})
		},
	} satisfies Action<typeof routes.integrationLogo>
}

function logoResponse(
	object: R2ObjectBody,
	headers: { contentType: string | null; cacheControl: string },
) {
	return new Response(object.body, {
		headers: {
			'Cache-Control': headers.cacheControl,
			'Content-Length': String(object.size),
			'Content-Type': headers.contentType ?? 'application/octet-stream',
			ETag: object.httpEtag,
			'X-Content-Type-Options': 'nosniff',
		},
	})
}
