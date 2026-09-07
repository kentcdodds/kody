import { type Action } from 'remix/router'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'
import {
	optOutTipsEmails,
	tipsUnsubscribeOneClickBody,
	verifyTipsUnsubscribeToken,
} from '#worker/usage/tips-unsubscribe.ts'

function getUnsubscribeError(reason: 'missing_token' | 'invalid_token') {
	switch (reason) {
		case 'missing_token':
			return 'Unsubscribe token is required.'
		case 'invalid_token':
			return 'Unsubscribe link is invalid.'
		default: {
			const unreachable: never = reason
			return unreachable
		}
	}
}

export function createUnsubscribeTipsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const token = url.searchParams.get('token')
			const claims = await verifyTipsUnsubscribeToken({
				env,
				token,
			})
			const requestIp = getRequestIp(request) ?? undefined

			if (!claims) {
				const reason = token?.trim() ? 'invalid_token' : 'missing_token'
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'auth',
					action: 'tips_unsubscribe',
					result: 'failure',
					ip: requestIp,
					path: url.pathname,
					reason,
				})
				if (request.method === 'POST') {
					return new Response(getUnsubscribeError(reason), {
						status: 400,
						headers: { 'content-type': 'text/plain; charset=utf-8' },
					})
				}
				return renderAppPage({
					request,
					env,
					title: 'Unsubscribe from tips',
					status: 400,
					loaderData: {
						tipsUnsubscribe: {
							ok: false,
							error: getUnsubscribeError(reason),
						},
					},
				})
			}

			if (request.method === 'POST') {
				const body = (await request.text()).trim()
				if (body && body !== tipsUnsubscribeOneClickBody) {
					void logAuditEvent({
						db: auditDatabaseFromEnv(env),
						category: 'auth',
						action: 'tips_unsubscribe',
						result: 'failure',
						ip: requestIp,
						path: url.pathname,
						reason: 'invalid_one_click_body',
					})
					return new Response('Invalid one-click unsubscribe body.', {
						status: 400,
						headers: { 'content-type': 'text/plain; charset=utf-8' },
					})
				}
			}

			const result = await optOutTipsEmails({
				db: env.APP_DB,
				userId: claims.userId,
			})
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'tips_unsubscribe',
				result: result.optedOut ? 'success' : 'failure',
				ip: requestIp,
				path: url.pathname,
				reason: result.alreadyOptedOut
					? 'already_opted_out'
					: result.optedOut
						? 'opted_out'
						: 'user_not_found',
			})

			if (!result.optedOut) {
				if (request.method === 'POST') {
					return new Response('Unsubscribe link is invalid.', {
						status: 400,
						headers: { 'content-type': 'text/plain; charset=utf-8' },
					})
				}
				return renderAppPage({
					request,
					env,
					title: 'Unsubscribe from tips',
					status: 400,
					loaderData: {
						tipsUnsubscribe: {
							ok: false,
							error: 'Unsubscribe link is invalid.',
						},
					},
				})
			}

			const message = result.alreadyOptedOut
				? 'You were already unsubscribed from Kody tips.'
				: 'You are unsubscribed from Kody tips. Transactional mail such as verification, billing, and error-rate alerts is unchanged.'
			if (request.method === 'POST') {
				return new Response(message, {
					status: 200,
					headers: { 'content-type': 'text/plain; charset=utf-8' },
				})
			}
			return renderAppPage({
				request,
				env,
				title: 'Unsubscribed from tips',
				loaderData: {
					tipsUnsubscribe: {
						ok: true,
						alreadyOptedOut: result.alreadyOptedOut,
						message,
					},
				},
			})
		},
	} satisfies Action<typeof routes.unsubscribeTips>
}
