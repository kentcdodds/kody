import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import { loadAdminSystemEmailData } from '#app/admin-system-email-data.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { type routes } from '#app/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'

async function auditSystemEmailRead(input: {
	env: Env
	request: Request
	actorEmail?: string | null
	action: 'admin_system_email_list' | 'admin_system_email_get'
	messageId?: string | null
}) {
	await logAuditEvent({
		db: input.env.APP_DB,
		category: 'admin',
		action: input.action,
		result: 'success',
		email: input.actorEmail ?? undefined,
		ip: getRequestIp(input.request) ?? undefined,
		path: new URL(input.request.url).pathname,
		reason: input.messageId
			? `target_message_id=${input.messageId}`
			: 'system_email_list',
	})
}

export function createAdminSystemEmailHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			let actor: Awaited<ReturnType<typeof requireUserWithRole>>
			try {
				actor = await requireUserWithRole(request, env, 'admin')
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}

			const { session } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const adminSystemEmail = await loadAdminSystemEmailData(env, request.url)
			await auditSystemEmailRead({
				env,
				request,
				actorEmail: actor.email,
				action: adminSystemEmail.selectedMessage
					? 'admin_system_email_get'
					: 'admin_system_email_list',
				messageId: adminSystemEmail.selectedMessage?.id,
			})

			return renderAppPage({
				request,
				env,
				title: 'Admin system email',
				loaderData: { adminSystemEmail },
			})
		},
	} satisfies Action<typeof routes.adminSystemEmail>
}

export function createAdminSystemEmailApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				const actor = await requireUserWithRole(request, env, 'admin')
				const payload = await loadAdminSystemEmailData(env, request.url)
				await auditSystemEmailRead({
					env,
					request,
					actorEmail: actor.email,
					action: payload.selectedMessage
						? 'admin_system_email_get'
						: 'admin_system_email_list',
					messageId: payload.selectedMessage?.id,
				})
				return jsonResponse(payload)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminSystemEmailApi>
}
