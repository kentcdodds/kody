import { type Action } from 'remix/router'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	localExecuteFlagKey,
	mcpApiToolFlagKey,
} from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'
import { setFeatureFlagUserOverride } from '#worker/feature-flags/service.ts'

const openApiOptInFlagKeys = [mcpApiToolFlagKey, localExecuteFlagKey] as const

function openApiDocsLocation(request: Request) {
	return new URL(routes.docDetail.href({ slug: 'open-api' }), request.url)
}

export function createOpenApiOptInHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLogin(request, {
					redirectTo: routes.docDetail.href({ slug: 'open-api' }),
				})
			}

			for (const key of openApiOptInFlagKeys) {
				await setFeatureFlagUserOverride(env.APP_DB, {
					key,
					userId: user.userId,
					enabled: true,
					updatedBy: user.userId,
				})
			}

			const requestIp = getRequestIp(request) ?? undefined
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'account',
				action: 'feature_flag_self_opt_in',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: routes.openApiOptInPost.href(),
				reason: `key=${openApiOptInFlagKeys.join(',')}`,
			})

			return Response.redirect(openApiDocsLocation(request), 302)
		},
	} satisfies Action<typeof routes.openApiOptInPost>
}
