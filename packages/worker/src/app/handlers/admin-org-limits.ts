import { type Action } from 'remix/router'
import { jsonResponse } from '#worker/json-response.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { type routes } from '#universal/routes.ts'
import { parseLimitOverrideKey } from '#universal/plans.ts'
import {
	AdminOrgLimitOverrideError,
	applyAdminOrgLimitOverrideChanges,
	loadAdminOrgLimits,
	type AdminOrgLimitOverrideChange,
} from '#worker/admin/org-limit-overrides.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'

function parseChanges(value: unknown): Array<AdminOrgLimitOverrideChange> {
	if (!Array.isArray(value)) {
		throw new AdminOrgLimitOverrideError(400, 'changes must be an array.')
	}
	return value.map((entry: unknown) => {
		const change = (entry ?? {}) as Record<string, unknown>
		const key = parseLimitOverrideKey(change.key)
		if (!key) {
			throw new AdminOrgLimitOverrideError(400, 'Unknown limit key.')
		}
		const raw = change.value
		const changeValue =
			raw === null || raw === 'unlimited' || typeof raw === 'number'
				? raw
				: undefined
		if (changeValue === undefined) {
			throw new AdminOrgLimitOverrideError(
				400,
				`${key} needs a number, "unlimited", or null to remove.`,
			)
		}
		const expiresAt = change.expiresAt
		if (
			expiresAt !== undefined &&
			expiresAt !== null &&
			typeof expiresAt !== 'string'
		) {
			throw new AdminOrgLimitOverrideError(400, 'expiresAt must be a string.')
		}
		return { key, value: changeValue, expiresAt }
	})
}

/**
 * Admin limit overrides for one org: GET reads plan, override, and
 * effective limits (`?orgId=` or `?org=`); POST applies changes with a
 * reason. Admin role only, matching the `adminOrgLimit*` capabilities.
 */
export function createAdminOrgLimitsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				const admin = await requireUserWithRole(request, env, 'admin')
				if (request.method === 'GET') {
					const params = new URL(request.url).searchParams
					return jsonResponse({
						ok: true,
						...(await loadAdminOrgLimits({
							db: env.APP_DB,
							target: {
								orgId: params.get('orgId') ?? undefined,
								org: params.get('org') ?? undefined,
							},
						})),
					})
				}
				if (request.method !== 'POST') {
					return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
				}
				const body = (await request.json().catch(() => null)) as {
					orgId?: unknown
					changes?: unknown
					reason?: unknown
				} | null
				if (typeof body?.orgId !== 'string') {
					return jsonResponse({ ok: false, error: 'orgId is required.' }, 400)
				}
				const result = await applyAdminOrgLimitOverrideChanges({
					db: env.APP_DB,
					audit: orgAuditWriterFromRequest(env, admin.request),
					target: { orgId: body.orgId },
					changes: parseChanges(body.changes),
					reason: body.reason,
				})
				return jsonResponse({ ok: true, ...result })
			} catch (error) {
				if (error instanceof Response) return error
				if (error instanceof AdminOrgLimitOverrideError) {
					return jsonResponse({ ok: false, error: error.message }, error.status)
				}
				throw error
			}
		},
	} satisfies Action<
		typeof routes.adminOrgLimitsApi | typeof routes.adminOrgLimitsApiPost
	>
}
