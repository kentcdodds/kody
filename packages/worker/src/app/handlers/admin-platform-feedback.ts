import { type Action } from 'remix/router'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import {
	loadAdminPlatformFeedbackData,
	readAdminPlatformFeedbackId,
} from '#app/admin-platform-feedback-data.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { type routes } from '#app/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { jsonResponse } from '#worker/json-response.ts'

const maxAuditFeedbackIdLength = 200

function readRequestedFeedbackId(request: Request) {
	return readAdminPlatformFeedbackId(
		new URL(request.url).searchParams.get('feedbackId'),
	)
}

function sanitizeFeedbackIdForAudit(feedbackId: string) {
	return feedbackId
		.replace(/[^A-Za-z0-9._:-]/g, '?')
		.slice(0, maxAuditFeedbackIdLength)
}

async function auditPlatformFeedbackRead(input: {
	env: Env
	request: Request
	actorEmail?: string | null
	action: 'admin_platform_feedback_list' | 'admin_platform_feedback_get'
	feedbackId?: string | null
	notFound?: boolean
}) {
	await logAuditEvent({
		db: input.env.APP_DB,
		category: 'admin',
		action: input.action,
		result: 'success',
		email: input.actorEmail ?? undefined,
		ip: getRequestIp(input.request) ?? undefined,
		path: new URL(input.request.url).pathname,
		reason: input.feedbackId
			? `feedback_id=${sanitizeFeedbackIdForAudit(input.feedbackId)}${
					input.notFound ? ';not_found' : ''
				}`
			: 'platform_feedback_list',
	})
}

export function createAdminPlatformFeedbackHandler(env: Env) {
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

			const adminPlatformFeedback = await loadAdminPlatformFeedbackData(
				env,
				request.url,
			)
			const requestedFeedbackId = readRequestedFeedbackId(request)
			await auditPlatformFeedbackRead({
				env,
				request,
				actorEmail: actor.email,
				action: requestedFeedbackId
					? 'admin_platform_feedback_get'
					: 'admin_platform_feedback_list',
				feedbackId: requestedFeedbackId,
				notFound:
					requestedFeedbackId !== null &&
					adminPlatformFeedback.selectedFeedback === null,
			})

			return renderAppPage({
				request,
				env,
				title: 'Admin platform feedback',
				loaderData: { adminPlatformFeedback },
			})
		},
	} satisfies Action<typeof routes.adminPlatformFeedback>
}

export function createAdminPlatformFeedbackApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				const actor = await requireUserWithRole(request, env, 'admin')
				const payload = await loadAdminPlatformFeedbackData(env, request.url)
				const requestedFeedbackId = readRequestedFeedbackId(request)
				await auditPlatformFeedbackRead({
					env,
					request,
					actorEmail: actor.email,
					action: requestedFeedbackId
						? 'admin_platform_feedback_get'
						: 'admin_platform_feedback_list',
					feedbackId: requestedFeedbackId,
					notFound:
						requestedFeedbackId !== null && payload.selectedFeedback === null,
				})
				return jsonResponse(payload)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminPlatformFeedbackApi>
}
