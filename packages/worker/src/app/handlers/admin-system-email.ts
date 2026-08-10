import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { loadAdminSystemEmailData } from '#worker/admin/system-email-data.ts'
import { requirePageUserWithRole } from '#app/page-auth.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { type routes } from '#universal/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'

async function auditSystemEmailRead(input: {
	env: Env
	request: Request
	actorEmail?: string | null
	action: 'admin_system_email_list' | 'admin_system_email_get'
	messageId?: string | null
}) {
	await logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
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
			const actor = await requirePageUserWithRole(request, env, 'admin')
			if (actor instanceof Response) {
				return actor
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
