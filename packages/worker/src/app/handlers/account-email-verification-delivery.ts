import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type routes } from '#universal/routes.ts'

/**
 * Session-scoped delivery poll for `/pending-verification`.
 * Identity comes only from the signed-in cookie — never from email/token
 * query params — so callers cannot probe other addresses.
 */
export function createAccountEmailVerificationDeliveryHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false }, 401)
			}
			if (request.method !== 'GET') {
				return jsonResponse({ ok: false }, 405)
			}
			if (user.emailVerified) {
				return jsonResponse({
					ok: true,
					emailVerified: true,
					delivery: null,
				})
			}
			return jsonResponse({
				ok: true,
				emailVerified: false,
				delivery: user.emailVerificationDelivery,
			})
		},
	} satisfies Action<typeof routes.accountEmailVerificationDelivery>
}
