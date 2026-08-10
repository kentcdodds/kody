import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	deriveOnboardingChecklist,
	dismissOnboardingChecklist,
	readOnboardingChecklistDismissed,
	userHasSentWelcomeEmail,
} from '#mcp/onboarding-checklist.ts'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadOnboardingFeaturedListings } from '#app/community-data.ts'
import { buildPlatformOauthAppLogoPath } from '#worker/integrations/platform-app-logo.ts'
import { listTopPlatformAppsByUse } from '#worker/integrations/platform-apps.ts'
import {
	type OnboardingBuiltInProvider,
	type OnboardingChecklistLoaderData,
} from '#universal/loader-data.ts'
import {
	loadOnboardingData,
	loadPublicOnboardingData,
} from '#app/onboarding-data.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

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

/**
 * First-win Send sub-step: successful `email_send` or stored outbound mail.
 * Fails open to false so a Mailbox or UserMeter blip never breaks the payload.
 */
async function loadHasSentWelcomeEmail(
	env: Env,
	userId: string,
): Promise<boolean> {
	return await userHasSentWelcomeEmail({ env, userId })
}

const onboardingBuiltInProviderLimit = 6

/**
 * Top enabled built-in integrations by adoption, offered as one-click
 * connects in the wizard. Fails open to an empty list so a D1 blip (or a
 * deployment with no platform apps) never breaks the onboarding payload.
 */
export async function loadOnboardingBuiltInProviders(
	env: Env,
): Promise<Array<OnboardingBuiltInProvider>> {
	try {
		const apps = await listTopPlatformAppsByUse({
			db: env.APP_DB,
			limit: onboardingBuiltInProviderLimit,
		})
		return apps.map((app) => ({
			slug: app.slug,
			label: app.label ?? app.slug,
			logoPath: buildPlatformOauthAppLogoPath(app),
		}))
	} catch {
		return []
	}
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
					builtInProviders: await loadOnboardingBuiltInProviders(env),
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
				builtInProviders: await loadOnboardingBuiltInProviders(env),
			})
			;[onboarding.checklist, onboarding.hasSentWelcomeEmail] =
				await Promise.all([
					loadChecklist(env, user.mcpUser.userId, onboarding.hasMcpClient),
					loadHasSentWelcomeEmail(env, user.mcpUser.userId),
				])
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
					builtInProviders: await loadOnboardingBuiltInProviders(env),
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
				builtInProviders: user.emailVerified
					? await loadOnboardingBuiltInProviders(env)
					: [],
			})
			if (user.emailVerified) {
				;[onboarding.checklist, onboarding.hasSentWelcomeEmail] =
					await Promise.all([
						loadChecklist(env, user.mcpUser.userId, onboarding.hasMcpClient),
						loadHasSentWelcomeEmail(env, user.mcpUser.userId),
					])
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
