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
import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import {
	getUsernameFormatValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	addTeamMember,
	createTeam,
	removeTeamMember,
} from '#worker/orgs/access-writes.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { listOrgMembers } from '#worker/orgs/org-members-list.ts'
import { listTeamsWithMembers } from '#worker/orgs/org-teams-list.ts'
import {
	type OrgMemberView,
	type OrgTeamMemberView,
	type OrgTeamView,
	type OrgTeamsLoaderData,
} from '#universal/loader-data.ts'
import { serializeLastUsedOrgCookie } from '#universal/org-last-used-cookie.ts'
import { orgRoleLabel } from '#universal/org-pages.ts'
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
		title: access.status === 404 ? 'Organization unavailable' : 'Teams',
		...(access.status === 404 ? { notFound: true } : { unauthorized: true }),
		status: access.status,
	})
}

function toTeamMemberView(member: {
	userId: string
	username: string | null
	displayName: string | null
	avatarKey: string | null
}): OrgTeamMemberView {
	return {
		userId: member.userId,
		username: member.username,
		displayName: member.displayName,
		avatarUrl: member.username
			? buildUserAvatarUrl({
					username: member.username,
					avatarKey: member.avatarKey,
				})
			: null,
	}
}

function toOrgMemberView(member: {
	userId: string
	username: string | null
	displayName: string | null
	avatarKey: string | null
	role: 'owner' | 'member' | 'billing'
}): OrgMemberView {
	return {
		userId: member.userId,
		username: member.username,
		displayName: member.displayName,
		avatarUrl: member.username
			? buildUserAvatarUrl({
					username: member.username,
					avatarKey: member.avatarKey,
				})
			: null,
		role: member.role,
		roleLabel: orgRoleLabel(member.role),
	}
}

async function loadOrgTeamsData(input: {
	env: Env
	user: Parameters<typeof orgHasPermission>[1]
	org: ManagedOrg
}): Promise<OrgTeamsLoaderData> {
	const canManage =
		!input.org.personal &&
		(await orgHasPermission(input.env, input.user, 'team:write'))
	const canRemoveMembers =
		!input.org.personal &&
		(await orgHasPermission(input.env, input.user, 'team:delete'))
	const [teams, orgMembers] = await Promise.all([
		listTeamsWithMembers(input.env.APP_DB, input.org.id),
		canManage
			? listOrgMembers(input.env.APP_DB, input.org.id)
			: Promise.resolve([]),
	])
	return {
		ok: true,
		org: input.org,
		teams: teams.map((team): OrgTeamView => ({
			id: team.id,
			slug: team.slug,
			name: team.name,
			description: team.description,
			memberCount: team.memberCount,
			members: team.members.map(toTeamMemberView),
		})),
		orgMembers: orgMembers.map(toOrgMemberView),
		canManage,
		canRemoveMembers,
	}
}

function personalOrgTeamWriteResponse() {
	return jsonResponse(
		{
			ok: false,
			error:
				'Teams belong to team organizations. Create a team organization to group people.',
		},
		400,
	)
}

async function readJsonObject(request: Request) {
	const body = await request.json().catch(() => null)
	if (!body || typeof body !== 'object') return null
	return body as Record<string, unknown>
}

export function createOrgTeamsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) return user
			const access = await resolveOrgManagementAccess({
				request,
				env,
				user,
				permission: 'team:read',
			})
			if (!access.ok) return renderDenied(request, env, access)
			return withLastUsedOrg(
				request,
				access.org.slug,
				await renderAppPage({
					request,
					env,
					title: 'Teams',
					loaderData: {
						orgTeams: await loadOrgTeamsData({
							env,
							user,
							org: access.org,
						}),
					},
				}),
			)
		},
	} satisfies Action<typeof routes.orgTeams>
}

export function createOrgTeamsApiHandler(env: Env) {
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
				permission: 'team:read',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			return jsonResponse(
				await loadOrgTeamsData({ env, user, org: access.org }),
			)
		},
	} satisfies Action<typeof routes.orgTeamsApi>
}

export function createOrgTeamsCreatePostHandler(env: Env) {
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
				permission: 'team:write',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			if (access.org.personal) return personalOrgTeamWriteResponse()
			const body = await readJsonObject(request)
			const slugRaw = typeof body?.slug === 'string' ? body.slug : ''
			const nameRaw = typeof body?.name === 'string' ? body.name : ''
			const description =
				typeof body?.description === 'string' ? body.description : undefined
			const slug = normalizeUsername(slugRaw)
			const formatError = getUsernameFormatValidationError(slug)
			if (formatError) {
				return jsonResponse({ ok: false, error: formatError }, 400)
			}
			const name = nameRaw.trim() || slug
			if (!name) {
				return jsonResponse(
					{ ok: false, error: 'A team name is required.' },
					400,
				)
			}
			try {
				await createTeam({
					db: env.APP_DB,
					orgId: access.org.id,
					slug,
					name,
					description,
					createdByUserId: user.mcpUser.userId,
					audit: orgAuditWriterFromRequest(env, user.request),
				})
			} catch (error) {
				const message =
					error instanceof Error ? error.message : 'Unable to create that team.'
				const conflict =
					/UNIQUE|unique|already exists/i.test(message) ||
					message.includes('constraint')
				return jsonResponse(
					{
						ok: false,
						error: conflict
							? 'A team with that handle already exists.'
							: message,
					},
					conflict ? 409 : 400,
				)
			}
			return jsonResponse(
				await loadOrgTeamsData({ env, user, org: access.org }),
			)
		},
	} satisfies Action<typeof routes.orgTeamsCreatePost>
}

export function createOrgTeamsMemberAddPostHandler(env: Env) {
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
				permission: 'team:write',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			if (access.org.personal) return personalOrgTeamWriteResponse()
			const body = await readJsonObject(request)
			const teamId = typeof body?.teamId === 'string' ? body.teamId.trim() : ''
			const userId = typeof body?.userId === 'string' ? body.userId.trim() : ''
			if (!teamId || !userId) {
				return jsonResponse(
					{ ok: false, error: 'A team and member are required.' },
					400,
				)
			}
			try {
				await addTeamMember({
					db: env.APP_DB,
					orgId: access.org.id,
					teamId,
					userId,
					addedByUserId: user.mcpUser.userId,
					audit: orgAuditWriterFromRequest(env, user.request),
				})
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: 'Unable to add that person to the team.'
				return jsonResponse({ ok: false, error: message }, 400)
			}
			return jsonResponse(
				await loadOrgTeamsData({ env, user, org: access.org }),
			)
		},
	} satisfies Action<typeof routes.orgTeamsMemberAddPost>
}

export function createOrgTeamsMemberRemovePostHandler(env: Env) {
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
				permission: 'team:delete',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			if (access.org.personal) return personalOrgTeamWriteResponse()
			const body = await readJsonObject(request)
			const teamId = typeof body?.teamId === 'string' ? body.teamId.trim() : ''
			const userId = typeof body?.userId === 'string' ? body.userId.trim() : ''
			if (!teamId || !userId) {
				return jsonResponse(
					{ ok: false, error: 'A team and member are required.' },
					400,
				)
			}
			try {
				await removeTeamMember({
					db: env.APP_DB,
					orgId: access.org.id,
					teamId,
					userId,
					audit: orgAuditWriterFromRequest(env, user.request),
				})
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: 'Unable to remove that person from the team.'
				return jsonResponse({ ok: false, error: message }, 400)
			}
			return jsonResponse(
				await loadOrgTeamsData({ env, user, org: access.org }),
			)
		},
	} satisfies Action<typeof routes.orgTeamsMemberRemovePost>
}
