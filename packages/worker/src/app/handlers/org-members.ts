import { type Action } from 'remix/router'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { isSecureRequest } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	orgHasPermission,
	resolveOrgManagementAccess,
	type ManagedOrg,
} from '#app/org-management-access.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { computeEffectivePermissions } from '#worker/authorization/authorize.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import {
	getUsernameFormatValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	createInvite,
	softDeleteOrgMember,
	updateOrgMemberRole,
} from '#worker/orgs/access-writes.ts'
import { assertCanAcceptFreeOrgOwnership } from '#worker/orgs/billing.ts'
import {
	countLiveOwners,
	getLiveOrgMembership,
	listOrgMembers,
	listPendingOrgInvites,
	type ListedOrgInvite,
	type ListedOrgMember,
} from '#worker/orgs/org-members-list.ts'
import { syncSeatsAfterMembershipChange } from '#worker/orgs/seat-sync-after-membership.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import {
	type OrgInviteView,
	type OrgMemberView,
	type OrgMembersLoaderData,
} from '#universal/loader-data.ts'
import { serializeLastUsedOrgCookie } from '#universal/org-last-used-cookie.ts'
import { orgRoleLabel } from '#universal/org-pages.ts'
import { type routes } from '#universal/routes.ts'

const orgRoleValues = ['owner', 'member', 'billing'] as const

function isOrgRole(value: unknown): value is OrgRole {
	return (
		typeof value === 'string' &&
		(orgRoleValues as ReadonlyArray<string>).includes(value)
	)
}

function seatRole(role: string) {
	return role === 'owner' || role === 'member'
}

function generateInviteToken() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

function inviteAcceptPrompt(input: { orgSlug: string; token: string }) {
	return `You are invited to the ${input.orgSlug} organization. Call inviteAccept with this token: ${input.token}. The token is shown once and cannot be looked up later.`
}

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
		title: access.status === 404 ? 'Organization unavailable' : 'Members',
		...(access.status === 404 ? { notFound: true } : { unauthorized: true }),
		status: access.status,
	})
}

function toMemberView(member: ListedOrgMember): OrgMemberView {
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

function toInviteView(invite: ListedOrgInvite): OrgInviteView {
	return {
		id: invite.id,
		kind: invite.kind,
		role: invite.role,
		roleLabel: invite.role ? orgRoleLabel(invite.role) : null,
		inviteeEmail: invite.inviteeEmail,
		inviteeUsername: invite.inviteeUsername,
		expiresAt: invite.expiresAt,
	}
}

async function loadOrgMembersData(input: {
	env: Env
	user: Parameters<typeof orgHasPermission>[1]
	org: ManagedOrg
}): Promise<OrgMembersLoaderData> {
	// Signup orgs keep membership management off the web — invite flows there
	// would let a second owner treat the account org like a team org.
	const canManage =
		!input.org.personal &&
		(await orgHasPermission(input.env, input.user, 'member:write'))
	const [members, invites] = await Promise.all([
		listOrgMembers(input.env.APP_DB, input.org.id),
		canManage
			? listPendingOrgInvites(input.env.APP_DB, input.org.id)
			: Promise.resolve([]),
	])
	return {
		ok: true,
		org: input.org,
		members: members.map(toMemberView),
		invites: invites.map(toInviteView),
		canManage,
	}
}

function personalOrgMembershipWriteResponse() {
	return jsonResponse(
		{
			ok: false,
			error:
				'Membership for your personal organization is managed with your account. Create a team organization to invite people.',
		},
		400,
	)
}

export function createOrgMembersHandler(env: Env) {
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
					title: 'Members',
					loaderData: {
						orgMembers: await loadOrgMembersData({
							env,
							user,
							org: access.org,
						}),
					},
				}),
			)
		},
	} satisfies Action<typeof routes.orgMembers>
}

export function createOrgMembersApiHandler(env: Env) {
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
				await loadOrgMembersData({ env, user, org: access.org }),
			)
		},
	} satisfies Action<typeof routes.orgMembersApi>
}

async function readJsonObject(request: Request) {
	const body = await request.json().catch(() => null)
	if (!body || typeof body !== 'object') return null
	return body as Record<string, unknown>
}

export function createOrgMembersRolePostHandler(env: Env) {
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
			if (access.org.personal) return personalOrgMembershipWriteResponse()
			const body = await readJsonObject(request)
			const userId = typeof body?.userId === 'string' ? body.userId.trim() : ''
			const role = body?.role
			if (!userId || !isOrgRole(role)) {
				return jsonResponse(
					{ ok: false, error: 'A member and role are required.' },
					400,
				)
			}
			const membership = await getLiveOrgMembership(
				env.APP_DB,
				access.org.id,
				userId,
			)
			if (!membership) {
				return jsonResponse(
					{
						ok: false,
						error: 'That person is not a member of this organization.',
					},
					404,
				)
			}
			if (membership.role === 'owner' || role === 'owner') {
				const permissions = await computeEffectivePermissions({
					env,
					request: user.request,
				})
				if (!permissions.isOwner) {
					return jsonResponse(
						{ ok: false, error: 'Only an Owner can change the Owner role.' },
						403,
					)
				}
			}
			const demotingOwner = membership.role === 'owner' && role !== 'owner'
			if (demotingOwner) {
				const owners = await countLiveOwners(env.APP_DB, access.org.id)
				if (owners <= 1) {
					return jsonResponse(
						{ ok: false, error: 'The last Owner cannot be demoted.' },
						400,
					)
				}
			}
			if (role === 'owner' && membership.role !== 'owner') {
				await assertCanAcceptFreeOrgOwnership({
					db: env.APP_DB,
					orgId: access.org.id,
					userId,
				})
			}
			try {
				await updateOrgMemberRole({
					db: env.APP_DB,
					orgId: access.org.id,
					userId,
					role,
					protectLastOwner: demotingOwner,
				})
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: 'Unable to update that member.'
				return jsonResponse({ ok: false, error: message }, 400)
			}
			if (seatRole(membership.role) !== seatRole(role)) {
				await syncSeatsAfterMembershipChange({
					db: env.APP_DB,
					env,
					orgId: access.org.id,
				})
			}
			return jsonResponse(
				await loadOrgMembersData({ env, user, org: access.org }),
			)
		},
	} satisfies Action<typeof routes.orgMembersRolePost>
}

export function createOrgMembersRemovePostHandler(env: Env) {
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
				permission: 'member:delete',
			})
			if (!access.ok) {
				return jsonResponse({ ok: false, error: access.error }, access.status)
			}
			if (access.org.personal) return personalOrgMembershipWriteResponse()
			const body = await readJsonObject(request)
			const userId = typeof body?.userId === 'string' ? body.userId.trim() : ''
			if (!userId) {
				return jsonResponse({ ok: false, error: 'A member is required.' }, 400)
			}
			const membership = await getLiveOrgMembership(
				env.APP_DB,
				access.org.id,
				userId,
			)
			if (!membership) {
				return jsonResponse(
					{
						ok: false,
						error: 'That person is not a member of this organization.',
					},
					404,
				)
			}
			const removingOwner = membership.role === 'owner'
			if (removingOwner) {
				const permissions = await computeEffectivePermissions({
					env,
					request: user.request,
				})
				if (!permissions.isOwner) {
					return jsonResponse(
						{ ok: false, error: 'Only an Owner can remove an Owner.' },
						403,
					)
				}
				const owners = await countLiveOwners(env.APP_DB, access.org.id)
				if (owners <= 1) {
					return jsonResponse(
						{ ok: false, error: 'The last Owner cannot be removed.' },
						400,
					)
				}
			}
			try {
				await softDeleteOrgMember({
					db: env.APP_DB,
					orgId: access.org.id,
					userId,
					protectLastOwner: removingOwner,
				})
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: 'Unable to remove that member.'
				return jsonResponse({ ok: false, error: message }, 400)
			}
			if (seatRole(membership.role)) {
				await syncSeatsAfterMembershipChange({
					db: env.APP_DB,
					env,
					orgId: access.org.id,
				})
			}
			return jsonResponse(
				await loadOrgMembersData({ env, user, org: access.org }),
			)
		},
	} satisfies Action<typeof routes.orgMembersRemovePost>
}

export function createOrgMembersInvitePostHandler(env: Env) {
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
			if (access.org.personal) return personalOrgMembershipWriteResponse()
			const body = await readJsonObject(request)
			const invitee =
				typeof body?.invitee === 'string' ? body.invitee.trim() : ''
			const emailInput =
				typeof body?.email === 'string' ? body.email.trim() : ''
			const usernameInput =
				typeof body?.username === 'string' ? body.username.trim() : ''
			const role = isOrgRole(body?.role) ? body.role : 'member'
			let inviteeEmail: string | null = null
			let inviteeUsername: string | null = null
			if (emailInput || (invitee.includes('@') && !usernameInput)) {
				const email = normalizeEmailAddress(emailInput || invitee)
				if (!email) {
					return jsonResponse(
						{ ok: false, error: 'Enter a valid email address.' },
						400,
					)
				}
				inviteeEmail = email
			} else {
				const username = normalizeUsername(usernameInput || invitee)
				const formatError = getUsernameFormatValidationError(username)
				if (formatError) {
					return jsonResponse(
						{ ok: false, error: 'Enter an email or a valid username.' },
						400,
					)
				}
				inviteeUsername = username
			}
			if (role === 'owner') {
				const permissions = await computeEffectivePermissions({
					env,
					request: user.request,
				})
				if (!permissions.isOwner) {
					return jsonResponse(
						{ ok: false, error: 'Only an Owner can invite another Owner.' },
						403,
					)
				}
			}
			const token = generateInviteToken()
			const tokenHash = await sha256Hex(token)
			const created = await createInvite({
				db: env.APP_DB,
				orgId: access.org.id,
				kind: 'membership',
				role,
				inviteeEmail,
				inviteeUsername,
				invitedByUserId: user.mcpUser.userId,
				tokenHash,
			})
			const payload = await loadOrgMembersData({ env, user, org: access.org })
			return jsonResponse({
				...payload,
				invite: {
					id: created.id,
					expiresAt: created.expiresAt,
					token,
					prompt: inviteAcceptPrompt({
						orgSlug: access.org.slug,
						token,
					}),
				},
			})
		},
	} satisfies Action<typeof routes.orgMembersInvitePost>
}
