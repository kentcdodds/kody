import { type Action } from 'remix/router'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { mcpSkillsExtensionFlagKey } from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'
import { setFeatureFlagUserOverride } from '#worker/feature-flags/service.ts'

function packageSkillsDocsLocation(request: Request) {
	return new URL(routes.docDetail.href({ slug: 'package-skills' }), request.url)
}

export function createPackageSkillsOptInHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLogin(request, {
					redirectTo: routes.docDetail.href({ slug: 'package-skills' }),
				})
			}

			await setFeatureFlagUserOverride(env.APP_DB, {
				key: mcpSkillsExtensionFlagKey,
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
				path: routes.packageSkillsOptInPost.href(),
				reason: `key=${mcpSkillsExtensionFlagKey}`,
			})

			return Response.redirect(packageSkillsDocsLocation(request), 302)
		},
	} satisfies Action<typeof routes.packageSkillsOptInPost>
}
