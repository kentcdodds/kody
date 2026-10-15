import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import {
	applyOrgFollowsPost,
	loadOrgFollowsData,
	loadPackageFollowState,
	orgFollowsPostStatus,
	parseOrgFollowsPostBody,
} from '#app/follows-web.ts'
import { resolveOrgManagementAccess } from '#app/org-management-access.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { isFollowTargetKind } from '#worker/follow/types.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { type OrgFollowsPostPayload } from '#universal/follows.ts'
import { type routes } from '#universal/routes.ts'

/** `/@slug/-/follows`: what this org follows. Reached through the org section. */
export function createAccountFollowsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) return redirectToLogin(request)
			const access = await resolveOrgManagementAccess({
				request,
				env,
				user,
				permission: 'org:read',
			})
			if (!access.ok) {
				return renderAppPage({
					request,
					env,
					title: 'Organization unavailable',
					notFound: true,
					status: 404,
				})
			}
			const orgFollows = await loadOrgFollowsData({ env, org: access.org })
			return renderAppPage({
				request,
				env,
				title: 'Follows',
				loaderData: { orgFollows },
			})
		},
	}
}

export function createOrgFollowsApiHandler(env: Env) {
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
				permission: 'org:read',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			return jsonResponse(await loadOrgFollowsData({ env, org: access.org }))
		},
	} satisfies Action<typeof routes.orgFollowsApi>
}

export function createOrgFollowsApiPostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				const payload: OrgFollowsPostPayload = {
					ok: false,
					code: 'unauthorized',
					error: 'Sign in to follow.',
				}
				return jsonResponse(payload, 401)
			}
			const access = await resolveOrgManagementAccess({
				request,
				env,
				user,
				permission: 'org:read',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			const body = parseOrgFollowsPostBody(
				await request.json().catch(() => null),
			)
			if (!body) {
				const payload: OrgFollowsPostPayload = {
					ok: false,
					code: 'invalid',
					error: 'Invalid request body.',
				}
				return jsonResponse(payload, 400)
			}
			const payload = await applyOrgFollowsPost({
				env,
				user,
				org: access.org,
				body,
			})
			return jsonResponse(payload, orgFollowsPostStatus(payload))
		},
	} satisfies Action<typeof routes.orgFollowsApiPost>
}

/**
 * Follow control data for a package or plain repo page. A target the viewer
 * cannot follow is a 404, the same as one that does not exist.
 */
export function createCommunityPackageFollowApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const kind = new URL(request.url).searchParams.get('kind') ?? ''
			const state = await loadPackageFollowState({
				env,
				user,
				username: params.username,
				kodyId: params.kodyId,
				kind: isFollowTargetKind(kind) ? kind : undefined,
			})
			if (!state) {
				return jsonResponse({ ok: false, error: 'Not found.' }, 404)
			}
			return jsonResponse(state)
		},
	} satisfies Action<typeof routes.communityPackageFollowApi>
}
