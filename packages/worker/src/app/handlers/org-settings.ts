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
import { processUserAvatar } from '#worker/community/avatar.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	buildOrgAvatarUrl,
	deleteOrgAvatar,
	saveOrgAvatar,
} from '#worker/orgs/org-avatar.ts'
import { updateOrgProfile } from '#worker/orgs/org-profile.ts'
import { softDeleteOrg } from '#worker/orgs/soft-delete.ts'
import { type OrgSettingsLoaderData } from '#universal/loader-data.ts'
import { serializeLastUsedOrgCookie } from '#universal/org-last-used-cookie.ts'
import { routes } from '#universal/routes.ts'

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
		title: access.status === 404 ? 'Organization unavailable' : 'Settings',
		...(access.status === 404 ? { notFound: true } : { unauthorized: true }),
		status: access.status,
	})
}

async function loadOrgSettingsData(input: {
	env: Env
	user: Parameters<typeof orgHasPermission>[1]
	org: ManagedOrg
}): Promise<OrgSettingsLoaderData> {
	// Signup orgs keep identity and deletion on Account pages even when
	// another owner somehow holds org:write on that org.
	const teamOrg = !input.org.personal
	return {
		ok: true,
		org: input.org,
		canManage:
			teamOrg && (await orgHasPermission(input.env, input.user, 'org:write')),
		canDelete:
			teamOrg && (await orgHasPermission(input.env, input.user, 'org:delete')),
	}
}

export function createOrgSettingsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) return user
			const access = await resolveOrgManagementAccess({
				request,
				env,
				user,
				permission: 'org:read',
			})
			if (!access.ok) return renderDenied(request, env, access)
			return withLastUsedOrg(
				request,
				access.org.slug,
				await renderAppPage({
					request,
					env,
					title: 'Settings',
					loaderData: {
						orgSettings: await loadOrgSettingsData({
							env,
							user,
							org: access.org,
						}),
					},
				}),
			)
		},
	} satisfies Action<typeof routes.orgSettings>
}

export function createOrgSettingsApiHandler(env: Env) {
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
			return jsonResponse(
				await loadOrgSettingsData({ env, user, org: access.org }),
			)
		},
	} satisfies Action<typeof routes.orgSettingsApi>
}

export function createOrgSettingsPostHandler(env: Env) {
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
				permission: 'org:write',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			if (access.org.personal) {
				return jsonResponse(
					{
						ok: false,
						error: 'Your name, photo, and handle live on your account profile.',
					},
					400,
				)
			}
			const body = (await request.json().catch(() => null)) as {
				displayName?: unknown
				slug?: unknown
			} | null
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}
			const updated = await updateOrgProfile(env.APP_DB, {
				orgId: access.org.id,
				displayName:
					typeof body.displayName === 'string' ? body.displayName : undefined,
				slug: typeof body.slug === 'string' ? body.slug : undefined,
			})
			if (!updated.ok) {
				return jsonResponse({ ok: false, error: updated.error }, 400)
			}
			const next = {
				...access.org,
				slug: updated.slug,
				displayName: updated.displayName,
			}
			return jsonResponse(await loadOrgSettingsData({ env, user, org: next }))
		},
	} satisfies Action<typeof routes.orgSettingsPost>
}

async function readFileBytes(file: File): Promise<Uint8Array> {
	return new Uint8Array(await file.arrayBuffer())
}

export function createOrgSettingsAvatarPostHandler(env: Env) {
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
				permission: 'org:write',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			if (access.org.personal) {
				return jsonResponse(
					{
						ok: false,
						error: 'Your photo lives on your account profile.',
					},
					400,
				)
			}

			const contentType = request.headers.get('Content-Type') ?? ''
			if (contentType.includes('application/json')) {
				const body = await request.json().catch(() => null)
				if (
					!body ||
					typeof body !== 'object' ||
					(body as Record<string, unknown>).remove !== true
				) {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}
				await deleteOrgAvatar({ env, orgId: access.org.id })
				return jsonResponse(
					await loadOrgSettingsData({
						env,
						user,
						org: { ...access.org, avatarUrl: null },
					}),
				)
			}

			let formData: FormData
			try {
				formData = await request.formData()
			} catch {
				return jsonResponse(
					{
						ok: false,
						error: 'Expected multipart form data with an avatar file.',
					},
					400,
				)
			}
			const avatar = formData.get('avatar')
			if (!(avatar instanceof File) || avatar.size === 0) {
				return jsonResponse(
					{ ok: false, error: 'Avatar file is required.' },
					400,
				)
			}
			let sourceBytes: Uint8Array
			try {
				sourceBytes = await readFileBytes(avatar)
			} catch (error) {
				console.error('org-avatar-read-failed', error)
				return jsonResponse({ ok: false, error: 'Unable to read avatar.' }, 500)
			}
			let processed: ReturnType<typeof processUserAvatar>
			try {
				processed = processUserAvatar({
					contentType: avatar.type || 'application/octet-stream',
					sourceBytes,
				})
			} catch (error) {
				const message =
					error instanceof Error ? error.message : 'Unable to process avatar.'
				return jsonResponse({ ok: false, error: message }, 400)
			}
			try {
				const avatarKey = await saveOrgAvatar({
					env,
					orgId: access.org.id,
					bytes: processed.bytes,
					contentType: processed.contentType,
				})
				return jsonResponse(
					await loadOrgSettingsData({
						env,
						user,
						org: {
							...access.org,
							avatarUrl: buildOrgAvatarUrl({
								slug: access.org.slug,
								avatarKey,
							}),
						},
					}),
				)
			} catch (error) {
				console.error('org-avatar-save-failed', error)
				return jsonResponse({ ok: false, error: 'Unable to save avatar.' }, 500)
			}
		},
	} satisfies Action<typeof routes.orgSettingsAvatarPost>
}

export function createOrgSettingsDeletePostHandler(env: Env) {
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
				permission: 'org:delete',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			if (access.org.personal) {
				return jsonResponse(
					{
						ok: false,
						error:
							'Your personal organization is your account. Delete it from Account → Data & deletion.',
					},
					400,
				)
			}
			const body = (await request.json().catch(() => null)) as {
				confirmation?: unknown
			} | null
			const confirmation =
				typeof body?.confirmation === 'string' ? body.confirmation.trim() : ''
			if (confirmation !== access.org.slug && confirmation !== 'DELETE') {
				return jsonResponse(
					{
						ok: false,
						error: `Type ${access.org.slug} or DELETE to confirm.`,
					},
					400,
				)
			}
			await softDeleteOrg({
				env,
				orgId: access.org.id,
				actorUserId: user.mcpUser.userId,
			})
			return jsonResponse({
				ok: true,
				redirectTo: routes.accountOrganizations.href(),
			})
		},
	} satisfies Action<typeof routes.orgSettingsDeletePost>
}
