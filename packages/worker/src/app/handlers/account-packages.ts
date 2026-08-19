import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { handleAccountPackageTokenAction } from '#app/account-package-tokens.ts'
import { loadAccountPackagesData } from '#app/account-packages-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'

export function createAccountPackagesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountPackages = await loadAccountPackagesData({
				env,
				request,
				user,
				pathPackageId:
					typeof params === 'object' &&
					params !== null &&
					'packageId' in params &&
					typeof params.packageId === 'string'
						? params.packageId
						: undefined,
			})
			return renderAppPage({
				request,
				env,
				title: 'Packages',
				loaderData: { accountPackages },
			})
		},
	} satisfies Action<
		typeof routes.accountPackages | typeof routes.accountPackageDetail
	>
}

export function createAccountPackagesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(
					await loadAccountPackagesData({ env, request, user }),
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object' || Array.isArray(body)) {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const tokenResponse = await handleAccountPackageTokenAction({
				env,
				request,
				user,
				body,
			})
			if (tokenResponse) return tokenResponse

			return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
		},
	} satisfies Action<
		typeof routes.accountPackagesApi | typeof routes.accountPackagesApiPost
	>
}
