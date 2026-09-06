import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { isSecureRequest } from '#app/auth-session.ts'
import { readNonEmptyTrimmedStringOrNumber } from '#app/request-body.ts'
import { type routes } from '#universal/routes.ts'
import {
	addDismissedBannerId,
	readSiteBannerDismissCookie,
	siteBannerDismissCookie,
} from '#universal/site-banner-cookie.ts'
import {
	dismissSiteBannerForUser,
	getSiteBanner,
} from '#worker/site-banners/service.ts'
import { isSiteBannerId } from '#universal/site-banners.ts'

export function createSiteBannerDismissHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const bannerId = readNonEmptyTrimmedStringOrNumber(body, 'bannerId')
			if (!bannerId || !isSiteBannerId(bannerId)) {
				return jsonResponse(
					{ ok: false, error: 'bannerId must be a UUID.' },
					400,
				)
			}

			const banner = await getSiteBanner(env.APP_DB, bannerId)
			if (!banner) {
				return jsonResponse({ ok: false, error: 'Banner not found.' }, 404)
			}
			if (!banner.dismissible) {
				return jsonResponse(
					{ ok: false, error: 'This banner cannot be dismissed.' },
					400,
				)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (user) {
				await dismissSiteBannerForUser(env.APP_DB, {
					bannerId,
					userId: user.userId,
				})
			}

			const dismissedIds = addDismissedBannerId(
				readSiteBannerDismissCookie(request.headers.get('Cookie')),
				bannerId,
			)
			const headers = new Headers({
				'Set-Cookie': siteBannerDismissCookie({
					ids: dismissedIds,
					secure: isSecureRequest(request),
				}),
			})
			return jsonResponse({ ok: true, bannerId }, { headers })
		},
	} satisfies Action<typeof routes.siteBannerDismissPost>
}
