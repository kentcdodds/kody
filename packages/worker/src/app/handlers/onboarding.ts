import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import {
	normalizeRedirectTo,
	redirectToLogin,
	redirectToLoginWhenUnauthenticated,
} from '#app/auth-redirect.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadOnboardingData } from '#app/onboarding-data.ts'
import { createPageOgHeadNode } from '#app/ssr-document.tsx'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

function redirectUnverifiedToPending(request: Request) {
	const requestUrl = new URL(request.url)
	const redirectTo = normalizeRedirectTo(
		requestUrl.searchParams.get('redirectTo'),
	)
	const pendingUrl = new URL('/pending-verification', requestUrl)
	if (redirectTo) {
		pendingUrl.searchParams.set('redirectTo', redirectTo)
	}
	return Response.redirect(pendingUrl, 302)
}

export function createOnboardingHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const { session } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLoginWhenUnauthenticated(request, env)
			}

			if (!user.emailVerified) {
				return redirectUnverifiedToPending(request)
			}

			const onboarding = await loadOnboardingData({
				env,
				requestUrl: request.url,
				stableUserId: user.mcpUser.userId,
				emailVerified: user.emailVerified,
			})
			const origin = getAppBaseUrl({ env, requestUrl: request.url })
			return renderAppPage({
				request,
				env,
				title: 'Get started',
				extraHead: createPageOgHeadNode({ origin, pageId: 'onboarding' }),
				loaderData: { onboarding },
			})
		},
	} satisfies Action<typeof routes.onboarding>
}

export function createOnboardingApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			// Unverified callers still get a payload so clients can detect the
			// gate; MCP URL/setup fields stay empty until verification succeeds.
			return jsonResponse(
				await loadOnboardingData({
					env,
					requestUrl: request.url,
					stableUserId: user.mcpUser.userId,
					emailVerified: user.emailVerified,
				}),
			)
		},
	} satisfies Action<typeof routes.onboardingApi>
}
