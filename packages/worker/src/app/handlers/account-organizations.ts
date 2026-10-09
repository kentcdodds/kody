import { type Action } from 'remix/router'
import { jsonResponse } from '#worker/json-response.ts'
import { loadAccountOrganizationSnapshot } from '#app/account-organizations-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { routes } from '#universal/routes.ts'

function readFormValue(body: FormData, key: string) {
	const value = body.get(key)
	return typeof value === 'string' ? value : ''
}

export function createAccountOrganizationsNewHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) return user
			const url = new URL(request.url)
			return renderAppPage({
				request,
				env,
				title: 'Create organization',
				loaderData: {
					accountOrganizations: {
						ok: true,
						error: url.searchParams.get('error'),
					},
				},
			})
		},
	} satisfies Action<typeof routes.accountOrganizationsNew>
}

export function createAccountOrganizationsNewPostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const body = await request.formData().catch(() => null)
			if (!body) {
				return redirectWithError(request, 'Enter a name and a URL slug.')
			}
			const created = await createOrganization(env.APP_DB, env, {
				personId: user.mcpUser.userId,
				slug: readFormValue(body, 'slug'),
				displayName: readFormValue(body, 'displayName'),
			})
			if (!created.ok) return redirectWithError(request, created.error)
			const destination = new URL(`/@${created.slug}`, request.url)
			return Response.redirect(destination.toString(), 302)
		},
	} satisfies Action<typeof routes.accountOrganizationsNewPost>
}

function redirectWithError(request: Request, error: string) {
	const destination = new URL(
		routes.accountOrganizationsNew.href(),
		request.url,
	)
	destination.searchParams.set('error', error)
	return Response.redirect(destination.toString(), 302)
}

export function createAccountInvitesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) return user
			const snapshot = await loadAccountOrganizationSnapshot(env, user, request)
			return renderAppPage({
				request,
				env,
				title: 'Invites',
				loaderData: {
					accountInvites: { ok: true, invites: snapshot.invites },
				},
			})
		},
	} satisfies Action<typeof routes.accountInvites>
}

export function createAccountInvitesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const snapshot = await loadAccountOrganizationSnapshot(env, user, request)
			return jsonResponse({ ok: true, invites: snapshot.invites })
		},
	} satisfies Action<typeof routes.accountInvitesApi>
}
