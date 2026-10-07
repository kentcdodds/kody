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
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { type routes } from '#universal/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { deleteSystemEmailMessageById } from '#worker/email/system-email-graph-store.ts'

async function auditSystemEmailAccess(input: {
	env: Env
	request: Request
	actorEmail?: string | null
	action:
		| 'adminSystemEmailList'
		| 'adminSystemEmailGet'
		| 'adminSystemEmailDelete'
	result?: 'success' | 'failure'
	reason: string
}) {
	await logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: input.action,
		result: input.result ?? 'success',
		email: input.actorEmail ?? undefined,
		ip: getRequestIp(input.request) ?? undefined,
		path: new URL(input.request.url).pathname,
		reason: input.reason,
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
			await auditSystemEmailAccess({
				env,
				request,
				actorEmail: actor.email,
				action: adminSystemEmail.selectedMessage
					? 'adminSystemEmailGet'
					: 'adminSystemEmailList',
				reason: adminSystemEmail.selectedMessage
					? `target_message_id=${adminSystemEmail.selectedMessage.id}`
					: 'system_email_list',
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
				if (request.method === 'GET') {
					const actor = await requireUserWithRole(request, env, 'admin')
					const payload = await loadAdminSystemEmailData(env, request.url)
					await auditSystemEmailAccess({
						env,
						request,
						actorEmail: actor.email,
						action: payload.selectedMessage
							? 'adminSystemEmailGet'
							: 'adminSystemEmailList',
						reason: payload.selectedMessage
							? `target_message_id=${payload.selectedMessage.id}`
							: 'system_email_list',
					})
					return jsonResponse(payload)
				}

				if (request.method !== 'POST') {
					return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
				}

				const actor = await requireUserWithRole(request, env, 'admin')
				const body = await request.json().catch(() => null)
				if (!body || typeof body !== 'object') {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}

				const action = readTrimmedStringOrEmpty(body, 'action')
				if (action !== 'delete') {
					return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
				}

				const messageId = readTrimmedStringOrEmpty(body, 'message_id')
				if (!messageId) {
					return jsonResponse(
						{ ok: false, error: 'Message id is required.' },
						400,
					)
				}

				try {
					const deletion = await deleteSystemEmailMessageById({
						db: env.APP_DB,
						blobs: env.EMAIL_BLOBS,
						messageId,
					})
					if (!deletion.messageFound) {
						await auditSystemEmailAccess({
							env,
							request,
							actorEmail: actor.email,
							action: 'adminSystemEmailDelete',
							result: 'failure',
							reason: `System email message not found: ${messageId}`,
						})
						return jsonResponse(
							{ ok: false, error: 'System email message not found.' },
							404,
						)
					}
					await auditSystemEmailAccess({
						env,
						request,
						actorEmail: actor.email,
						action: 'adminSystemEmailDelete',
						reason: `target_message_id=${messageId}`,
					})
				} catch (error) {
					await auditSystemEmailAccess({
						env,
						request,
						actorEmail: actor.email,
						action: 'adminSystemEmailDelete',
						result: 'failure',
						reason:
							error instanceof Error && error.message.trim().length > 0
								? error.message.slice(0, 240)
								: 'unknown_error',
					})
					throw error
				}

				const listUrl = new URL(request.url, 'http://localhost')
				listUrl.searchParams.delete('messageId')
				return jsonResponse(
					await loadAdminSystemEmailData(env, listUrl.toString()),
				)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminSystemEmailApi>
}
