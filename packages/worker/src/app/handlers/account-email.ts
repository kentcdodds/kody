import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAccountEmailData } from '#app/account-email-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type AccountEmailLoaderData } from '#app/loader-data.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { type routes } from '#app/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'

function readPathMessageId(params: unknown) {
	if (
		typeof params === 'object' &&
		params !== null &&
		'messageId' in params &&
		typeof params.messageId === 'string'
	) {
		return params.messageId
	}
	return undefined
}

export function createAccountEmailHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountEmail = await loadAccountEmailData({
				env,
				request,
				user,
				pathMessageId: readPathMessageId(params),
			})
			return renderAppPage({
				request,
				env,
				title: 'Email inbox',
				loaderData: {
					accountEmail: accountEmail as AccountEmailLoaderData,
				},
			})
		},
	} satisfies Action<
		typeof routes.accountEmail | typeof routes.accountEmailDetail
	>
}

export function createAccountEmailApiHandler(env: Env) {
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

			return jsonResponse(await loadAccountEmailData({ env, request, user }))
		},
	} satisfies Action<typeof routes.accountEmailApi>
}
