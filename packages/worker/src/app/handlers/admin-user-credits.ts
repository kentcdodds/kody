import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { getRequestIp } from '#worker/audit-log.ts'
import { requireUserWithPermission } from '#app/permissions-server.ts'
import { type routes } from '#universal/routes.ts'
import {
	AdminCreditGrantError,
	grantAdminCreditsToUser,
	loadAdminCreditWallet,
} from '#worker/admin/credit-grants.ts'
import { isStableUserId, normalizeStableUserId } from '#worker/user-id.ts'

/**
 * Admin credit wallet for one account: GET reads balance and recent
 * ledger (grants show who granted and the note); POST grants credits,
 * including to the signed-in admin.
 */
export function createAdminUserCreditsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				if (request.method === 'GET') {
					await requireUserWithPermission(request, env, 'read:user:any')
					const stableUserId = normalizeStableUserId(
						new URL(request.url).searchParams.get('stableUserId'),
					)
					if (!isStableUserId(stableUserId)) {
						return jsonResponse(
							{ ok: false, error: 'stableUserId is required.' },
							400,
						)
					}
					const wallet = await loadAdminCreditWallet(env, { stableUserId })
					if (!wallet) {
						return jsonResponse({ ok: false, error: 'User not found.' }, 404)
					}
					return jsonResponse(wallet)
				}
				if (request.method !== 'POST') {
					return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
				}
				const actor = await requireUserWithPermission(
					request,
					env,
					'update:user:any',
				)
				const body = (await request.json().catch(() => null)) as {
					stableUserId?: unknown
					amountCents?: unknown
					note?: unknown
				} | null
				const stableUserId = normalizeStableUserId(
					typeof body?.stableUserId === 'string' ? body.stableUserId : '',
				)
				if (!isStableUserId(stableUserId)) {
					return jsonResponse(
						{ ok: false, error: 'stableUserId is required.' },
						400,
					)
				}
				const result = await grantAdminCreditsToUser({
					env,
					target: { stableUserId },
					grantedBy: {
						stableUserId: actor.mcpUser.userId,
						email: actor.email,
					},
					amountCents: body?.amountCents,
					note: body?.note,
					path: new URL(request.url).pathname,
					ip: getRequestIp(request) ?? undefined,
				})
				return jsonResponse(result.wallet)
			} catch (error) {
				if (error instanceof Response) return error
				if (error instanceof AdminCreditGrantError) {
					return jsonResponse({ ok: false, error: error.message }, error.status)
				}
				throw error
			}
		},
	} satisfies Action<
		typeof routes.adminUserCreditsApi | typeof routes.adminUserCreditsApiPost
	>
}
