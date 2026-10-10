import { type Action } from 'remix/router'
import { isSecureRequest } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	orgHasPermission,
	resolveOrgManagementAccess,
	type ManagedOrg,
} from '#app/org-management-access.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { jsonResponse } from '#worker/json-response.ts'
import { softDeleteGrant } from '#worker/orgs/access-writes.ts'
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

async function loadOrgGrantsData(input: {
	env: Env
	user: Parameters<typeof orgHasPermission>[1]
	org: ManagedOrg
}): Promise<OrgGrantsLoaderData> {
	const canManage =
		!input.org.personal &&
		(await orgHasPermission(input.env, input.user, 'member:write'))
	const grants = await listOrgGrantsForView(input.env.APP_DB, input.org.id)
	return {
		ok: true,
		org: input.org,
		grants,
		canManage,
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
			if (access.org.personal) {
				return jsonResponse(
					{
						ok: false,
						error:
							'Grants for your personal organization are managed elsewhere.',
					},
					400,
				)
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
			try {
				await softDeleteGrant({
					db: env.APP_DB,
					orgId: access.org.id,
					grantId,
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
