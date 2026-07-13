import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountPackagesData } from '#app/account-packages-data.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	redirectToLogin,
	redirectToLoginWhenUnauthenticated,
} from '#app/auth-redirect.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'

export function createAccountPackagesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const { session } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLoginWhenUnauthenticated(request, env)
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

			if (request.method !== 'GET') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			return jsonResponse(await loadAccountPackagesData({ env, request, user }))
		},
	} satisfies Action<typeof routes.accountPackagesApi>
}
