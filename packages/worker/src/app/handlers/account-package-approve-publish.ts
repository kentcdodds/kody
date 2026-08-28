import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountPackageApprovePublishData } from '#app/account-package-publish-lock.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

function readPackageId(params: unknown): string | null {
	if (
		typeof params === 'object' &&
		params !== null &&
		'packageId' in params &&
		typeof params.packageId === 'string' &&
		params.packageId.trim()
	) {
		return params.packageId.trim()
	}
	return null
}

export function createAccountPackageApprovePublishHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}
			const packageId = readPackageId(params)
			if (!packageId) {
				return new Response('Not found', { status: 404 })
			}
			const accountPackageApprovePublish =
				await loadAccountPackageApprovePublishData({
					env,
					request,
					user,
					packageId,
				})
			if (!accountPackageApprovePublish.ok) {
				return new Response(accountPackageApprovePublish.error, { status: 404 })
			}
			return renderAppPage({
				request,
				env,
				title: 'Approve package publish',
				loaderData: { accountPackageApprovePublish },
			})
		},
	} satisfies Action<typeof routes.accountPackageApprovePublish>
}

export function createAccountPackageApprovePublishApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}
			const packageId = readPackageId(params)
			if (!packageId) {
				return jsonResponse(
					{ ok: false, error: 'Package id is required.' },
					400,
				)
			}
			const payload = await loadAccountPackageApprovePublishData({
				env,
				request,
				user,
				packageId,
			})
			if (!payload.ok) {
				return jsonResponse(payload, 404)
			}
			return jsonResponse(payload)
		},
	} satisfies Action<typeof routes.accountPackageApprovePublishApi>
}
