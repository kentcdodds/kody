import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import {
	redirectToLogin,
	redirectToLoginWhenUnauthenticated,
} from '#app/auth-redirect.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadOnboardingData } from '#app/onboarding-data.ts'
import { createPageOgHeadNode } from '#app/ssr-document.tsx'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

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

			const onboarding = await loadOnboardingData({
				env,
				requestUrl: request.url,
				stableUserId: user.mcpUser.userId,
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

			return jsonResponse(
				await loadOnboardingData({
					env,
					requestUrl: request.url,
					stableUserId: user.mcpUser.userId,
				}),
			)
		},
	} satisfies Action<typeof routes.onboardingApi>
}
