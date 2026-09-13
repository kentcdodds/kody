import { type Action } from 'remix/router'
import { loadAccountConnectionsData } from '#app/account-connections-data.ts'
import { loadAccountProfileData } from '#app/account-profile-data.ts'
import {
	listEmailNotificationDestinations,
	maxAdditionalEmailNotificationDestinations,
} from '#worker/email/destinations.ts'
import { loadChecklist } from '#app/handlers/onboarding.ts'
import { loadOnboardingData } from '#app/onboarding-data.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

export function createAccountHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const [accountProfile, accountConnections, destinations, onboarding] =
				await Promise.all([
					loadAccountProfileData(user, env),
					loadAccountConnectionsData({ env, userId: user.userId }),
					listEmailNotificationDestinations({
						db: env.APP_DB,
						dbUserId: user.userId,
						accountEmail: user.email,
						accountEmailVerified: user.emailVerified,
					}),
					loadOnboardingData({
						env,
						requestUrl: request.url,
						stableUserId: user.mcpUser.userId,
						username: user.username,
						emailVerified: user.emailVerified,
					}),
				])
			const additionalCount = destinations.filter(
				(destination) => destination.kind === 'additional',
			).length
			const accountEmailDestinations = {
				ok: true as const,
				destinations,
				additionalLimit: maxAdditionalEmailNotificationDestinations,
				additionalRemaining: Math.max(
					0,
					maxAdditionalEmailNotificationDestinations - additionalCount,
				),
			}
			// The banner shows checklist progress, so the SSR payload needs the
			// checklist too — hydration keeps SSR data and does not refetch.
			if (user.emailVerified) {
				onboarding.checklist = await loadChecklist(
					env,
					user.mcpUser.userId,
					user.username,
					onboarding.hasMcpClient,
					{
						hasSecondMcpClient: onboarding.hasSecondMcpClient,
					},
				)
			}
			return renderAppPage({
				request,
				env,
				title: 'Account',
				loaderData: {
					accountProfile,
					accountConnections,
					accountEmailDestinations,
					onboarding,
				},
			})
		},
	} satisfies Action<typeof routes.account>
}
