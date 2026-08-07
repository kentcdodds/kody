import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	deriveOnboardingChecklist,
	dismissOnboardingChecklist,
	readOnboardingChecklistDismissed,
} from '#mcp/onboarding-checklist.ts'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadOnboardingFeaturedListings } from '#app/community-data.ts'
import { type OnboardingChecklistLoaderData } from '#app/loader-data.ts'
import {
	loadOnboardingData,
	loadPublicOnboardingData,
} from '#app/onboarding-data.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

/**
 * The checklist derives from existing signals (mailbox, memories,
 * integrations, saved packages), so it only computes for verified users —
 * unverified accounts have nothing to derive and should not pay the probes.
 */
export async function loadChecklist(
	env: Env,
	userId: string,
	hasMcpClient: boolean,
): Promise<OnboardingChecklistLoaderData> {
	const [checklist, dismissed] = await Promise.all([
		deriveOnboardingChecklist({
			env,
			userId,
			emailVerified: true,
			hasMcpClient,
		}),
		readOnboardingChecklistDismissed({ env, userId }),
	])
	return { items: checklist.items, dismissed }
}

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
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				const onboarding = {
					...loadPublicOnboardingData({
						env,
						requestUrl: request.url,
					}),
					featuredListings: await loadOnboardingFeaturedListings(env, request),
				}
				return renderAppPage({
					request,
					env,
					loaderData: { onboarding },
				})
			}

			if (!user.emailVerified) {
				return redirectUnverifiedToPending(request)
			}

			const onboarding = await loadOnboardingData({
				env,
				requestUrl: request.url,
				stableUserId: user.mcpUser.userId,
				emailVerified: user.emailVerified,
				featuredListings: await loadOnboardingFeaturedListings(env, request),
			})
			onboarding.checklist = await loadChecklist(
				env,
				user.mcpUser.userId,
				onboarding.hasMcpClient,
			)
			return renderAppPage({
				request,
				env,
				loaderData: { onboarding },
			})
		},
	} satisfies Action<typeof routes.onboarding>
}

export function createOnboardingApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({
					...loadPublicOnboardingData({
						env,
						requestUrl: request.url,
					}),
					featuredListings: await loadOnboardingFeaturedListings(env, request),
				})
			}

			// Unverified callers still get a payload so clients can detect the
			// gate; MCP URL/setup and featured fields stay empty until
			// verification succeeds.
			const onboarding = await loadOnboardingData({
				env,
				requestUrl: request.url,
				stableUserId: user.mcpUser.userId,
				emailVerified: user.emailVerified,
				featuredListings: user.emailVerified
					? await loadOnboardingFeaturedListings(env, request)
					: [],
			})
			if (user.emailVerified) {
				onboarding.checklist = await loadChecklist(
					env,
					user.mcpUser.userId,
					onboarding.hasMcpClient,
				)
			}
			return jsonResponse(onboarding)
		},
	} satisfies Action<typeof routes.onboardingApi>
}

export function createOnboardingChecklistDismissHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Sign in required.' }, 401)
			}
			await dismissOnboardingChecklist({ env, userId: user.mcpUser.userId })
			return jsonResponse({ ok: true })
		},
	} satisfies Action<typeof routes.onboardingChecklistDismissPost>
}
