import { type Action } from 'remix/router'
import { z } from 'zod'
import {
	decideApprovalBundleItem,
	loadApprovalViewerForSlug,
} from '#app/approval-bundle-decisions.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { loadApprovalBundleView } from '#worker/approval-bundles/service.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { type routes } from '#universal/routes.ts'

const decisionSchema = z.strictObject({
	action: z.enum(['approve', 'deny']),
	item: z.string().trim().min(1),
	fingerprint: z.string().trim().min(1),
})

/**
 * `/@:orgSlug/-/approvals/:bundleId`: the bundled approval page. Data comes
 * from `orgApprovalBundleApi`. Only the person the bundle was made for can
 * open it; anyone else sees not found.
 */
export function createOrgApprovalBundleHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) return user
			return renderAppPage({ request, env, title: 'Review approvals' })
		},
	} satisfies Action<typeof routes.orgApprovalBundle>
}

/**
 * GET returns the bundle as the signed-in person sees it now. POST
 * `{ action, item, fingerprint }` approves or denies one item. Session-only:
 * agents create bundles but never decide them.
 */
export function createOrgApprovalBundleApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			if (request.method !== 'GET' && request.method !== 'POST') {
				return jsonResponse(
					{ ok: false, error: 'Method not allowed.' },
					{ status: 405, headers: { Allow: 'GET, POST' } },
				)
			}
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const viewer = await loadApprovalViewerForSlug({
				env,
				request,
				user,
				orgSlug: params.orgSlug,
			})
			if (!viewer) {
				return jsonResponse(
					{ ok: false, error: 'Approval bundle not found.' },
					404,
				)
			}
			if (request.method === 'GET') {
				const data = await loadApprovalBundleView({
					viewer,
					bundleId: params.bundleId,
				})
				return jsonResponse(
					data.ok ? data.view : data,
					data.ok ? 200 : data.reason === 'expired' ? 410 : 404,
				)
			}
			const parsed = decisionSchema.safeParse(
				await request.json().catch(() => null),
			)
			if (!parsed.success) {
				return jsonResponse(
					{
						ok: false,
						error: `Invalid request body: ${parsed.error.issues[0]?.message ?? 'expected { action, item, fingerprint }'}.`,
						item: null,
					},
					400,
				)
			}
			const result = await decideApprovalBundleItem({
				viewer,
				request,
				user,
				bundleId: params.bundleId,
				decision: parsed.data,
			})
			return jsonResponse(result.body, result.status)
		},
	} satisfies Action<
		typeof routes.orgApprovalBundleApi | typeof routes.orgApprovalBundleApiPost
	>
}
