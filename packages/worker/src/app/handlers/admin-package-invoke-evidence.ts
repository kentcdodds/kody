import { type Action } from 'remix/router'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { loadPackageInvokePrefixlessEvidenceAggregate } from '#worker/package-invocations/prefixless-evidence-admin.ts'
import { type routes } from '#universal/routes.ts'

export function createAdminPackageInvokeEvidenceApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				await requireUserWithRole(request, env, 'admin')
				return jsonResponse(
					await loadPackageInvokePrefixlessEvidenceAggregate(env),
				)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminPackageInvokeEvidenceApi>
}
