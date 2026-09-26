import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	approveConnectWebhookApply,
	loadConnectWebhookApplyData,
	rejectConnectWebhookApply,
} from '#app/connect-webhook-apply-data.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { type routes } from '#universal/routes.ts'

function readTrimmedSearchParam(url: URL, name: string) {
	return url.searchParams.get(name)?.trim() || null
}

export function createAccountWebhooksApproveApplyApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			const requestUrl = new URL(request.url)
			if (request.method === 'GET') {
				return jsonResponse(
					await loadConnectWebhookApplyData({
						env,
						user,
						requestUrl: request.url,
					}),
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse(
					{ ok: false, error: 'Method not allowed.' },
					{ status: 405, headers: { Allow: 'GET, POST' } },
				)
			}

			const body = (await request.json().catch(() => null)) as {
				action?: unknown
			} | null
			const action = typeof body?.action === 'string' ? body.action.trim() : ''
			const handle = readTrimmedSearchParam(requestUrl, 'handle')
			const fingerprint = readTrimmedSearchParam(requestUrl, 'fingerprint')
			if (!handle || !fingerprint) {
				return jsonResponse(
					{
						ok: false,
						error: 'Approval links must include handle and fingerprint.',
					},
					400,
				)
			}

			try {
				if (action === 'approve') {
					return jsonResponse(
						await approveConnectWebhookApply({
							env,
							user,
							handle,
							fingerprint,
						}),
					)
				}
				if (action === 'reject') {
					return jsonResponse(
						await rejectConnectWebhookApply({
							env,
							user,
							handle,
							fingerprint,
						}),
					)
				}
				return jsonResponse(
					{ ok: false, error: 'Unknown approval action.' },
					400,
				)
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to process webhook apply approval.',
					},
					400,
				)
			}
		},
	} satisfies Action<
		| typeof routes.accountWebhooksApproveApplyApi
		| typeof routes.accountWebhooksApproveApplyApiPost
	>
}
