import { type Action } from 'remix/router'
import { authorizeGrantRevoke } from '#mcp/capabilities/access/shared.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { isSecureRequest } from '#app/auth-session.ts'
import {
	readAuthenticatedAppUser,
	type AuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import {
	orgHasPermission,
	resolveOrgManagementAccess,
	type ManagedOrg,
} from '#app/org-management-access.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	getGrantById,
	isGrantResourceType,
	softDeleteGrant,
} from '#worker/orgs/access-writes.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { listOrgGrantsForView } from '#worker/orgs/org-grants-view.ts'
import { type OrgGrantsLoaderData } from '#universal/loader-data.ts'
import { serializeLastUsedOrgCookie } from '#universal/org-last-used-cookie.ts'
import { type routes } from '#universal/routes.ts'

function withLastUsedOrg(request: Request, slug: string, response: Response) {
	const headers = new Headers(response.headers)
	headers.append(
		'Set-Cookie',
		serializeLastUsedOrgCookie({
			slug,
			secure: isSecureRequest(request),
		}),
	)
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

function renderDenied(
	request: Request,
	env: Env,
	access: { status: 403 | 404 },
) {
	return renderAppPage({
		request,
		env,
		title: access.status === 404 ? 'Organization unavailable' : 'Grants',
		...(access.status === 404 ? { notFound: true } : { unauthorized: true }),
		status: access.status,
	})
}

/**
 * Same resource check as grant revoke. Authorization and caller denials mean
 * this viewer cannot revoke the grant; anything else still fails the request.
 */
async function grantRevokeAllowed(
	env: Env,
	user: AuthenticatedAppUser,
	grant: { resourceType: string; resourceId: string },
) {
	if (!isGrantResourceType(grant.resourceType)) return false
	try {
		await authorizeGrantRevoke(
			{
				env,
				callerContext: {
					user: user.mcpUser,
					request: user.request,
				},
			},
			grant.resourceType,
			grant.resourceId,
		)
		return true
	} catch (error) {
		// AuthorizationError is an McpCallerError. Both are denials.
		if (error instanceof McpCallerError) return false
		throw error
	}
}

async function loadOrgGrantsData(input: {
	env: Env
	user: AuthenticatedAppUser
	org: ManagedOrg
}): Promise<OrgGrantsLoaderData> {
	const canManage = await orgHasPermission(
		input.env,
		input.user,
		'member:write',
	)
	const grants = await listOrgGrantsForView(input.env.APP_DB, input.org.id)
	return {
		ok: true,
		org: input.org,
		canManage,
		grants: await Promise.all(
			grants.map(async (grant) => ({
				...grant,
				canRevoke: await grantRevokeAllowed(input.env, input.user, grant),
			})),
		),
	}
}

async function readJsonObject(request: Request) {
	const body = await request.json().catch(() => null)
	if (!body || typeof body !== 'object') return null
	return body as Record<string, unknown>
}

export function createOrgGrantsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) return user
			const access = await resolveOrgManagementAccess({
				request,
				env,
				user,
				permission: 'member:read',
			})
			if (!access.ok) return renderDenied(request, env, access)
			return withLastUsedOrg(
				request,
				access.org.slug,
				await renderAppPage({
					request,
					env,
					title: 'Grants',
					loaderData: {
						orgGrants: await loadOrgGrantsData({
							env,
							user,
							org: access.org,
						}),
					},
				}),
			)
		},
	} satisfies Action<typeof routes.orgGrants>
}

export function createOrgGrantsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const access = await resolveOrgManagementAccess({
				request,
				env,
				user,
				permission: 'member:read',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			return jsonResponse(
				await loadOrgGrantsData({ env, user, org: access.org }),
			)
		},
	} satisfies Action<typeof routes.orgGrantsApi>
}

export function createOrgGrantsRevokePostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const access = await resolveOrgManagementAccess({
				request,
				env,
				user,
				permission: 'member:write',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			const body = await readJsonObject(request)
			const grantId =
				typeof body?.grantId === 'string' ? body.grantId.trim() : ''
			if (!grantId) {
				return jsonResponse(
					{ ok: false, error: 'A grant id is required.' },
					400,
				)
			}
			const grant = await getGrantById({
				db: env.APP_DB,
				orgId: access.org.id,
				grantId,
			})
			if (!grant || !isGrantResourceType(grant.resourceType)) {
				return jsonResponse(
					{ ok: false, error: 'Grant was not found in this organization.' },
					400,
				)
			}
			try {
				await authorizeGrantRevoke(
					{
						env,
						callerContext: {
							user: user.mcpUser,
							request: user.request,
						},
					},
					grant.resourceType,
					grant.resourceId,
				)
			} catch (error) {
				if (error instanceof AuthorizationError) {
					return jsonResponse({ ok: false, error: error.message }, 403)
				}
				if (error instanceof McpCallerError) {
					return jsonResponse({ ok: false, error: error.message }, 400)
				}
				throw error
			}
			try {
				await softDeleteGrant({
					db: env.APP_DB,
					orgId: access.org.id,
					grantId: grant.id,
					audit: orgAuditWriterFromRequest(env, user.request),
				})
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: 'Unable to revoke that grant.'
				return jsonResponse({ ok: false, error: message }, 400)
			}
			return jsonResponse(
				await loadOrgGrantsData({ env, user, org: access.org }),
			)
		},
	} satisfies Action<typeof routes.orgGrantsRevokePost>
}
