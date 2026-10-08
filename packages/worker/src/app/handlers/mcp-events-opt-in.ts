import { type Action } from 'remix/router'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { mcpEventsExtensionFlagKey } from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'
import { setFeatureFlagUserOverride } from '#worker/feature-flags/service.ts'

function mcpEventsDocsLocation(request: Request) {
	return new URL(routes.docDetail.href({ slug: 'mcp-events' }), request.url)
}

export function createMcpEventsOptInHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLogin(request, {
					redirectTo: routes.docDetail.href({ slug: 'mcp-events' }),
				})
			}

			await setFeatureFlagUserOverride(env.APP_DB, {
				key: mcpEventsExtensionFlagKey,
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
				path: routes.mcpEventsOptInPost.href(),
				reason: `key=${mcpEventsExtensionFlagKey}`,
			})

			return Response.redirect(mcpEventsDocsLocation(request), 302)
		},
	} satisfies Action<typeof routes.mcpEventsOptInPost>
}
