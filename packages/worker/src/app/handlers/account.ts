import { type Action } from 'remix/router'
import { loadAccountConnectionsData } from '#app/account-connections-data.ts'
import { loadAccountProfileData } from '#app/account-profile-data.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	redirectToLogin,
	redirectToLoginWhenUnauthenticated,
} from '#app/auth-redirect.ts'
import { loadOnboardingData } from '#app/onboarding-data.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

export function createAccountHandler(env: Env) {
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

			const [accountProfile, accountConnections, onboarding] =
				await Promise.all([
					loadAccountProfileData(user),
					loadAccountConnectionsData({ env, userId: user.userId }),
					loadOnboardingData({
						env,
						requestUrl: request.url,
						stableUserId: user.mcpUser.userId,
						emailVerified: user.emailVerified,
					}),
				])
			return renderAppPage({
				request,
				env,
				title: 'Account',
				loaderData: { accountProfile, accountConnections, onboarding },
			})
		},
	} satisfies Action<typeof routes.account>
}
