import { type Action } from 'remix/router'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { secretProvidersFlagKey } from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'
import { setFeatureFlagUserOverride } from '#worker/feature-flags/service.ts'

function secretProvidersDocsLocation(request: Request) {
	return new URL(
		routes.docDetail.href({ slug: 'secret-providers' }),
		request.url,
	)
}

export function createSecretProvidersOptInHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLogin(request, {
					redirectTo: routes.docDetail.href({ slug: 'secret-providers' }),
				})
			}

			await setFeatureFlagUserOverride(env.APP_DB, {
				key: secretProvidersFlagKey,
				userId: user.userId,
				enabled: true,
				updatedBy: user.userId,
			})

			const requestIp = getRequestIp(request) ?? undefined
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'account',
				action: 'feature_flag_self_opt_in',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: routes.secretProvidersOptInPost.href(),
				reason: `key=${secretProvidersFlagKey}`,
			})

			return Response.redirect(secretProvidersDocsLocation(request), 302)
		},
	} satisfies Action<typeof routes.secretProvidersOptInPost>
}
