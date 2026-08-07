import { type Action } from 'remix/router'
import { loadAccountConnectionsData } from '#app/account-connections-data.ts'
import { loadAccountProfileData } from '#app/account-profile-data.ts'
import { loadChecklist } from '#app/handlers/onboarding.ts'
import { loadOnboardingData } from '#app/onboarding-data.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

export function createAccountHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const [accountProfile, accountConnections, onboarding] =
				await Promise.all([
					loadAccountProfileData(user, env),
					loadAccountConnectionsData({ env, userId: user.userId }),
					loadOnboardingData({
						env,
						requestUrl: request.url,
						stableUserId: user.mcpUser.userId,
						emailVerified: user.emailVerified,
					}),
				])
			// The banner shows checklist progress, so the SSR payload needs the
			// checklist too — hydration keeps SSR data and does not refetch.
			if (user.emailVerified) {
				onboarding.checklist = await loadChecklist(
					env,
					user.mcpUser.userId,
					onboarding.hasMcpClient,
				)
			}
			return renderAppPage({
				request,
				env,
				title: 'Account',
				loaderData: { accountProfile, accountConnections, onboarding },
			})
		},
	} satisfies Action<typeof routes.account>
}
