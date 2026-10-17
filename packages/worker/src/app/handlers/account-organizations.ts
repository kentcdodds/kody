import { type Action } from 'remix/router'
import { jsonResponse } from '#worker/json-response.ts'
import { loadAccountOrganizationSnapshot } from '#app/account-organizations-data.ts'
import { loadAccountProfileData } from '#app/account-profile-data.ts'
import {
	readAuthenticatedAppUser,
	type AuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	authorize,
	AuthorizationError,
} from '#worker/authorization/authorize.ts'
import { FreeOrgLimitError } from '#worker/orgs/billing.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import {
	loadRestorableOrganizationBySlugForPerson,
	OrgRestoreWindowExpiredError,
	restoreOrg,
} from '#worker/orgs/soft-delete.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import { type AccountOrganizationsLoaderData } from '#universal/loader-data.ts'
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
					accountOrganizationsNew: {
						ok: true,
						error: url.searchParams.get('error'),
						restorableSlug: url.searchParams.get('restorableSlug'),
						draft: {
							displayName: url.searchParams.get('displayName') ?? '',
							slug: url.searchParams.get('slug') ?? '',
						},
					},
				},
			})
		},
	} satisfies Action<typeof routes.accountOrganizationsNew>
}

/**
 * Same authorization as MCP `orgCreate`: `org:write` on the bound request org
 * (the signup organization for `/account/...`), then {@link createOrganization}
 * which calls shared {@link createOrg}.
 */
export function createAccountOrganizationsNewPostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			try {
				await authorize({ env, request: user.request }, 'org:write')
			} catch (error) {
				if (error instanceof AuthorizationError) {
					return redirectWithError(
						request,
						'You do not have permission to create an organization.',
						{ displayName: '', slug: '' },
					)
				}
				throw error
			}
			const body = await request.formData().catch(() => null)
			if (!body) {
				return redirectWithError(request, 'Enter a name and a URL slug.', {
					displayName: '',
					slug: '',
				})
			}
			const draft = {
				displayName: readFormValue(body, 'displayName'),
				slug: readFormValue(body, 'slug'),
			}
			const created = await createOrganization(env.APP_DB, env, {
				personId: user.mcpUser.userId,
				audit: orgAuditWriterFromRequest(env, user.request),
				...draft,
			})
			if (!created.ok) {
				return redirectWithError(request, created.error, draft, {
					restorableSlug: created.restorableSlug,
				})
			}
			const destination = new URL(`/@${created.slug}`, request.url)
			return Response.redirect(destination.toString(), 302)
		},
	} satisfies Action<typeof routes.accountOrganizationsNewPost>
}

function redirectWithError(
	request: Request,
	error: string,
	draft: { displayName: string; slug: string },
	options?: { restorableSlug?: string },
) {
	const destination = new URL(
		routes.accountOrganizationsNew.href(),
		request.url,
	)
	destination.searchParams.set('error', error)
	if (draft.displayName) {
		destination.searchParams.set('displayName', draft.displayName)
	}
	if (draft.slug) destination.searchParams.set('slug', draft.slug)
	if (options?.restorableSlug) {
		destination.searchParams.set('restorableSlug', options.restorableSlug)
	}
	return Response.redirect(destination.toString(), 302)
}

async function loadAccountOrganizationsData(
	env: Env,
	user: AuthenticatedAppUser,
): Promise<AccountOrganizationsLoaderData> {
	const [snapshot, profile] = await Promise.all([
		loadAccountOrganizationSnapshot(env, user, { includeRestorable: true }),
		loadAccountProfileData(user, env),
	])
	return {
		ok: true,
		username: profile.username,
		viewer: { displayName: profile.displayName, avatarUrl: profile.avatarUrl },
		organizations: snapshot.organizations,
		restorableOrganizations: snapshot.restorableOrganizations,
		pendingInvites: snapshot.pendingInvites,
	}
}

export function createAccountOrganizationsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) return user
			return renderAppPage({
				request,
				env,
				title: 'Organizations',
				loaderData: {
					accountOrganizations: await loadAccountOrganizationsData(env, user),
				},
			})
		},
	} satisfies Action<typeof routes.accountOrganizations>
}

export function createAccountOrganizationsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			return jsonResponse(await loadAccountOrganizationsData(env, user))
		},
	} satisfies Action<typeof routes.accountOrganizationsApi>
}

/**
 * Restore a soft-deleted organization by handle. Authorization mirrors MCP
 * `orgRestore` (Owner at the deletion generation). The URL uses the slug so
 * the UI never needs a raw org id.
 */
export function createAccountOrganizationsRestorePostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const orgSlug = normalizeUsername(
				typeof params.orgSlug === 'string' ? params.orgSlug : '',
			)
			if (!orgSlug) {
				return jsonResponse(
					{ ok: false, error: 'That organization could not be restored.' },
					404,
				)
			}
			const restorable = await loadRestorableOrganizationBySlugForPerson({
				db: env.APP_DB,
				actorUserId: user.mcpUser.userId,
				slug: orgSlug,
			})
			if (!restorable) {
				return jsonResponse(
					{
						ok: false,
						error:
							'That organization is not available to restore. The 30-day window may have ended, or you were not an Owner when it was deleted.',
					},
					404,
				)
			}
			try {
				await restoreOrg({
					env,
					orgId: restorable.orgId,
					actorUserId: user.mcpUser.userId,
					actorUsername: user.username,
				})
			} catch (error) {
				if (error instanceof OrgRestoreWindowExpiredError) {
					return jsonResponse(
						{
							ok: false,
							error:
								'The 30-day restore window for this organization has expired.',
						},
						400,
					)
				}
				if (error instanceof FreeOrgLimitError) {
					return jsonResponse({ ok: false, error: error.message }, 400)
				}
				if (error instanceof Error && error.message === 'org_restore_race') {
					return jsonResponse(
						{
							ok: false,
							error:
								'That organization was already restored. Refresh and try again.',
						},
						409,
					)
				}
				throw error
			}
			return jsonResponse({
				ok: true,
				redirectTo: routes.profile.href({ username: restorable.slug }),
			})
		},
	} satisfies Action<typeof routes.accountOrganizationsRestorePost>
}
