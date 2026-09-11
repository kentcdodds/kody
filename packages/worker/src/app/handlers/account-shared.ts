import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountSharedData } from '#app/account-shared-data.ts'
import { applyPackageShareMutation } from '#app/package-share-actions.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { isPackageShareGrantsEnabled } from '#worker/package-registry/share-flag.ts'
import { type routes } from '#universal/routes.ts'

async function packageShareGrantsUnavailable(userId: number, env: Env) {
	return !(await isPackageShareGrantsEnabled({
		db: env.APP_DB,
		userId,
	}))
}

export function createAccountSharedHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}
			if (await packageShareGrantsUnavailable(user.userId, env)) {
				return new Response('Not found.', { status: 404 })
			}

			const accountShared = await loadAccountSharedData({ env, user })
			return renderAppPage({
				request,
				env,
				title: 'Shared packages',
				loaderData: { accountShared },
			})
		},
	} satisfies Action<typeof routes.accountShared>
}

export function createAccountSharedApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			if (await packageShareGrantsUnavailable(user.userId, env)) {
				return jsonResponse({ ok: false, error: 'Not found.' }, 404)
			}

			if (request.method === 'GET') {
				return jsonResponse(await loadAccountSharedData({ env, user }))
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			const result = await applyPackageShareMutation({
				env,
				user,
				body,
				requestUrl: request.url,
			})
			if (!result.ok) {
				return jsonResponse(result, result.status)
			}
			return jsonResponse({
				ok: true,
				grant: result.grant,
				shared: await loadAccountSharedData({ env, user }),
			})
		},
	} satisfies Action<typeof routes.accountSharedApi>
}
