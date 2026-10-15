import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	loadOrgTeamsData,
	personalOrgTeamWriteResponse,
} from '#app/handlers/org-teams.ts'
import {
	inviteLinkUrl,
	readInviteLinkOptions,
} from '#app/invite-link-options.ts'
import {
	orgHasPermission,
	resolveOrgManagementAccess,
} from '#app/org-management-access.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	createOrgInviteLink,
	generateInviteLinkToken,
	hashInviteLinkToken,
	revokeOrgInviteLink,
} from '#worker/orgs/invite-links.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { type routes } from '#universal/routes.ts'

async function readJsonObject(request: Request) {
	const body = await request.json().catch(() => null)
	if (!body || typeof body !== 'object') return null
	return body as Record<string, unknown>
}

/**
 * Team links add the person to the org (as Member when they are not one yet)
 * and to one team, so managing them takes both team:write and member:write.
 */
async function resolveTeamLinkAccess(request: Request, env: Env) {
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return {
			ok: false as const,
			response: jsonResponse({ ok: false, error: 'Unauthorized.' }, 401),
		}
	}
	const access = await resolveOrgManagementAccess({
		request,
		env,
		user,
		permission: 'team:write',
	})
	if (!access.ok) {
		return {
			ok: false as const,
			response: jsonResponse({ ok: false, error: access.error }, access.status),
		}
	}
	if (access.org.personal) {
		return { ok: false as const, response: personalOrgTeamWriteResponse() }
	}
	if (!(await orgHasPermission(env, user, 'member:write'))) {
		return {
			ok: false as const,
			response: jsonResponse(
				{
					ok: false,
					error:
						'Team links also add people to the organization, so they need permission to manage members.',
				},
				403,
			),
		}
	}
	return { ok: true as const, user, org: access.org }
}

export function createOrgTeamsInviteLinksPostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const access = await resolveTeamLinkAccess(request, env)
			if (!access.ok) return access.response
			const { user, org } = access
			const body = await readJsonObject(request)
			const teamId = typeof body?.teamId === 'string' ? body.teamId.trim() : ''
			if (!teamId) {
				return jsonResponse({ ok: false, error: 'Choose a team.' }, 400)
			}
			const parsedOptions = readInviteLinkOptions(body)
			if (!parsedOptions.ok) {
				return jsonResponse({ ok: false, error: parsedOptions.error }, 400)
			}
			const { allowedEmailDomains, maxUses, expiresAt } = parsedOptions.options
			const token = generateInviteLinkToken()
			const tokenHash = await hashInviteLinkToken(token)
			try {
				const created = await createOrgInviteLink({
					db: env.APP_DB,
					orgId: org.id,
					target: { kind: 'team', teamId },
					createdByUserId: user.mcpUser.userId,
					tokenHash,
					allowedEmailDomains,
					maxUses,
					expiresAt,
					audit: orgAuditWriterFromRequest(env, user.request),
				})
				return jsonResponse({
					...(await loadOrgTeamsData({ env, user, org })),
					inviteLink: {
						id: created.id,
						teamId,
						expiresAt: created.expiresAt,
						maxUses: created.maxUses,
						url: inviteLinkUrl(request, token),
					},
				})
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to create that invite link.',
					},
					400,
				)
			}
		},
	} satisfies Action<typeof routes.orgTeamsInviteLinksPost>
}

export function createOrgTeamsInviteLinksRevokePostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const access = await resolveTeamLinkAccess(request, env)
			if (!access.ok) return access.response
			const { user, org } = access
			const body = await readJsonObject(request)
			const linkId = typeof body?.linkId === 'string' ? body.linkId.trim() : ''
			if (!linkId) {
				return jsonResponse(
					{ ok: false, error: 'An invite link is required.' },
					400,
				)
			}
			try {
				await revokeOrgInviteLink({
					db: env.APP_DB,
					orgId: org.id,
					linkId,
					scope: { kind: 'team' },
					audit: orgAuditWriterFromRequest(env, user.request),
				})
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to revoke that invite link.',
					},
					400,
				)
			}
			return jsonResponse(await loadOrgTeamsData({ env, user, org }))
		},
	} satisfies Action<typeof routes.orgTeamsInviteLinksRevokePost>
}
