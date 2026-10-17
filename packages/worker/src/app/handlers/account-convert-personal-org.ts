import { type Action } from 'remix/router'
import { jsonResponse } from '#worker/json-response.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	ConvertPersonalOrgError,
	convertPersonalOrg,
} from '#worker/orgs/convert-personal-org.ts'
import { routes } from '#universal/routes.ts'

function readNewHandle(body: unknown) {
	if (!body || typeof body !== 'object') return ''
	const record = body as Record<string, unknown>
	const value = record.newHandle ?? record.slug ?? record.handle
	return typeof value === 'string' ? value : ''
}

/**
 * Convert the signed-in person's personal org into a team org and mint a new
 * personal org + username. Account settings only.
 */
export function createAccountConvertPersonalOrgPostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const body = await request.json().catch(() => null)
			const newHandle = readNewHandle(body)
			try {
				const result = await convertPersonalOrg({
					env,
					personId: user.mcpUser.userId,
					newHandle,
				})
				return jsonResponse({
					ok: true,
					convertedSlug: result.convertedSlug,
					newUsername: result.newUsername,
					redirectTo: routes.account.href(),
				})
			} catch (error) {
				if (error instanceof ConvertPersonalOrgError) {
					const status =
						error.code === 'handle_taken' ||
						error.code === 'invalid_handle' ||
						error.code === 'credential_grants' ||
						error.code === 'free_org_cap' ||
						error.code === 'not_personal'
							? 400
							: 500
					return jsonResponse(
						{ ok: false, error: error.message, code: error.code },
						status,
					)
				}
				throw error
			}
		},
	} satisfies Action<typeof routes.accountConvertPersonalOrgPost>
}
