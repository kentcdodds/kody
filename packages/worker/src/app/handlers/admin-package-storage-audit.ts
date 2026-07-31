import { type Action } from 'remix/router'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { type routes } from '#app/routes.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	buildPackageStorageAuditReport,
	defaultPackageStorageAuditLimit,
	InvalidStartAfterCursorError,
	maxPackageStorageAuditLimit,
} from '#worker/package-storage-audit/service.ts'
import { readPositiveInt } from '#worker/query-params.ts'

export function createAdminPackageStorageAuditApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			try {
				if (request.method !== 'GET') {
					return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
				}
				await requireUserWithRole(request, env, 'admin')
				const limit = readPositiveInt(
					url.searchParams.get('limit'),
					defaultPackageStorageAuditLimit,
					maxPackageStorageAuditLimit,
				)
				const startAfter = url.searchParams.get('startAfter')
				const report = await buildPackageStorageAuditReport({
					env,
					limit,
					startAfter,
				})
				return jsonResponse(report)
			} catch (error) {
				if (error instanceof Response) return error
				if (error instanceof InvalidStartAfterCursorError) {
					return jsonResponse({ ok: false, error: error.message }, 400)
				}
				throw error
			}
		},
	} satisfies Action<typeof routes.adminPackageStorageAuditApi>
}
