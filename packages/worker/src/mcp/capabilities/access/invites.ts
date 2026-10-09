import { resolveGrantPermissions } from '@kody-internal/shared/grant-presets.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import {
	authorize,
	computeEffectivePermissions,
} from '#worker/authorization/authorize.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	addOrgMember,
	addTeamMember,
	createInvite,
	getInviteById,
	getInviteByTokenHash,
	markInviteAccepted,
	markInviteExpired,
	markInviteRevoked,
	upsertGrant,
	type GrantResourceType,
	type StoredInvite,
} from '#worker/orgs/access-writes.ts'
import { assertCanAcceptFreeOrgOwnership } from '#worker/orgs/billing.ts'
import { syncSeatsAfterMembershipChange } from '#worker/orgs/seat-sync-after-membership.ts'
import {
	authorizeGrantTarget,
	generateInviteToken,
	grantPresetSchema,
	grantResourceTypeSchema,
	hashInviteToken,
	inviteAcceptPrompt,
	inviteSchema,
	optionalInviteeEmail,
	optionalInviteeUsername,
	orgRoleSchema,
	readPermissionList,
	requireLiveOrg,
	requireOrgPermission,
	requirePresetOrPermissions,
	resolveAuthorizedGrantPermissions,
	rethrowAccessError,
} from './shared.ts'

function inviteMatchesUser(
	invite: StoredInvite,
	user: { email: string; username?: string },
) {
	if (!invite.inviteeEmail && !invite.inviteeUsername) return false
	if (invite.inviteeEmail) {
		const email = normalizeEmail(user.email)
		if (email !== invite.inviteeEmail) return false
	}
	if (invite.inviteeUsername) {
		const username = normalizeUsername(user.username ?? '')
		if (username !== invite.inviteeUsername) return false
	}
	return true
}

async function assertTeamsInOrg(
	db: D1Database,
	orgId: string,
	teamIds: ReadonlyArray<string>,
) {
	for (const teamId of teamIds) {
		const row = await db
			.prepare(
				`SELECT id FROM teams
				 WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
			)
			.bind(teamId, orgId)
			.first<{ id: string }>()
		if (!row) {
			throw new McpCallerError(
				`Team ${teamId} was not found in this organization.`,
			)
		}
	}
}

function toInvitePayload(invite: StoredInvite, orgSlug: string) {
	return {
		id: invite.id,
		org_id: invite.orgId,
		org_slug: orgSlug,
		kind: invite.kind,
		role: invite.role,
		team_ids: invite.teamIds,
		resource_type: invite.resourceType,
		resource_id: invite.resourceId,
		preset: invite.preset,
		permissions: invite.permissions,
		invitee_email: invite.inviteeEmail,
		invitee_username: invite.inviteeUsername,
		status: invite.status,
		expires_at: invite.expiresAt,
	}
}

async function assertInviterStillValid(db: D1Database, invite: StoredInvite) {
	const requireOwner = invite.kind === 'membership' && invite.role === 'owner'
	const inviter = await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(invite.orgId, invite.invitedByUserId)
		.first<{ role: string }>()
	if (requireOwner) {
		if (!inviter || inviter.role !== 'owner') {
			throw new McpCallerError(
				'This owner invite is no longer valid because the inviter is not an Owner.',
			)
		}
		return
	}
	if (invite.kind === 'membership') {
		if (!inviter) {
			throw new McpCallerError(
				'This invite is no longer valid because the inviter no longer has access.',
			)
		}
		return
	}
	// Grant invites may come from outside collaborators who still hold a grant.
	if (inviter) return
	const grant = await db
		.prepare(
			`SELECT id FROM grants
			 WHERE org_id = ?
			   AND subject_type = 'user'
			   AND subject_id = ?
			   AND deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(invite.orgId, invite.invitedByUserId)
		.first<{ id: string }>()
	if (!grant) {
		throw new McpCallerError(
			'This invite is no longer valid because the inviter no longer has access.',
		)
	}
}

async function assertInviteTargetsStillValid(
	db: D1Database,
	invite: StoredInvite,
) {
	const kind = invite.kind
	switch (kind) {
		case 'membership':
			await assertTeamsInOrg(db, invite.orgId, invite.teamIds)
			return
		case 'grant': {
			if (!invite.resourceType || !invite.resourceId) {
				throw new McpCallerError('This grant invite is missing a resource.')
			}
			try {
				resolveGrantPermissions({
					resourceType: invite.resourceType,
					preset: invite.preset,
					permissions: invite.permissions,
				})
			} catch (error) {
				throw new McpCallerError(
					error instanceof Error ? error.message : 'Invalid grant invite.',
				)
			}
			return
		}
		default: {
			const exhaustive: never = kind
			throw new Error(`Unknown invite kind: ${String(exhaustive)}`)
		}
	}
}

async function acceptStoredInvite(input: {
	db: D1Database
	env: Env
	invite: StoredInvite
	acceptedByUserId: string
}) {
	const { invite } = input
	await assertInviterStillValid(input.db, invite)
	await assertInviteTargetsStillValid(input.db, invite)
	if (invite.kind === 'membership' && (invite.role ?? 'member') === 'owner') {
		await assertCanAcceptFreeOrgOwnership({
			db: input.db,
			orgId: invite.orgId,
			userId: input.acceptedByUserId,
		})
	}
	// Claim the invite before side effects so a concurrent redeem loses the
	// pending→accepted compare-and-set instead of applying access twice.
	try {
		await markInviteAccepted({
			db: input.db,
			inviteId: invite.id,
			acceptedByUserId: input.acceptedByUserId,
		})
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === 'Invite could not be accepted.'
		) {
			throw new McpCallerError('This invite was already accepted.')
		}
		throw error
	}
	const kind = invite.kind
	switch (kind) {
		case 'membership': {
			const role: OrgRole = invite.role ?? 'member'
			await addOrgMember({
				db: input.db,
				orgId: invite.orgId,
				userId: input.acceptedByUserId,
				role,
				invitedByUserId: invite.invitedByUserId,
			})
			for (const teamId of invite.teamIds) {
				await addTeamMember({
					db: input.db,
					orgId: invite.orgId,
					teamId,
					userId: input.acceptedByUserId,
					addedByUserId: invite.invitedByUserId,
				})
			}
			if (role === 'owner' || role === 'member') {
				await syncSeatsAfterMembershipChange({
					db: input.db,
					env: input.env,
					orgId: invite.orgId,
				})
			}
			break
		}
		case 'grant': {
			if (!invite.resourceType || !invite.resourceId) {
				throw new McpCallerError('This grant invite is missing a resource.')
			}
			await upsertGrant({
				db: input.db,
				orgId: invite.orgId,
				resourceType: invite.resourceType,
				resourceId: invite.resourceId,
				subject: { type: 'user', id: input.acceptedByUserId },
				preset: invite.preset,
				permissions: invite.permissions,
				createdByUserId: invite.invitedByUserId,
			})
			break
		}
		default: {
			const exhaustive: never = kind
			throw new Error(`Unknown invite kind: ${String(exhaustive)}`)
		}
	}
}

export const inviteCreateCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'inviteCreate',
		orgPermission: 'none',
		description:
			'Invite someone to the organization this request is bound to, by email or username. kind membership needs member:write and adds them with a role (and optional teams). kind grant needs manage access on the resource and gives them a preset or permission list. The token is returned once, with a prompt that tells them to call inviteAccept. Invites expire in 7 days.',
		keywords: ['invite', 'member', 'grant', 'email', 'username'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			kind: z.enum(['membership', 'grant']),
			email: z.string().min(1).optional(),
			username: z.string().min(1).optional(),
			role: orgRoleSchema.optional(),
			team_ids: z.array(z.string().min(1)).optional(),
			resource_type: grantResourceTypeSchema.optional(),
			resource_id: z.string().min(1).optional(),
			preset: grantPresetSchema.optional(),
			permissions: z.array(z.string().min(1)).optional(),
		}),
		outputSchema: z.object({
			invite: inviteSchema,
			token: z.string(),
			prompt: z.string(),
		}),
		async handler(args, ctx) {
			try {
				const user = requireMcpUser(ctx.callerContext)
				const request = requireMcpRequest(ctx.callerContext)
				const db = ctx.env.APP_DB
				const email = optionalInviteeEmail(args.email)
				const username = optionalInviteeUsername(args.username)
				const org = await requireLiveOrg(db, request.org.id)
				const kind = args.kind
				let role: OrgRole | null = null
				let teamIds: Array<string> | null = null
				let resourceType: GrantResourceType | null = null
				let resourceId: string | null = null
				let preset: 'use' | 'contribute' | 'manage' | null = null
				let permissions: Array<OrgPermission> | null = null
				switch (kind) {
					case 'membership': {
						await authorize({ env: ctx.env, request }, 'member:write')
						if (args.resource_type || args.resource_id || args.preset) {
							throw new McpCallerError(
								'Membership invites do not take a resource or preset. Use kind grant for that.',
							)
						}
						if (args.permissions && args.permissions.length > 0) {
							throw new McpCallerError(
								'Membership invites do not take a permission list.',
							)
						}
						role = args.role ?? 'member'
						if (role === 'owner') {
							const access = await computeEffectivePermissions({
								env: ctx.env,
								request,
							})
							if (!access.isOwner) {
								throw new McpCallerError(
									'Only an Owner can invite another Owner.',
								)
							}
						}
						const ids = args.team_ids ?? []
						await assertTeamsInOrg(db, request.org.id, ids)
						teamIds = ids.length > 0 ? ids : null
						break
					}
					case 'grant': {
						if (args.role || (args.team_ids && args.team_ids.length > 0)) {
							throw new McpCallerError(
								'Grant invites do not take a role or teams. Use kind membership for that.',
							)
						}
						if (!args.resource_type || !args.resource_id) {
							throw new McpCallerError(
								'Grant invites need resource_type and resource_id.',
							)
						}
						permissions = readPermissionList(args.permissions)
						requirePresetOrPermissions({
							preset: args.preset,
							permissions,
						})
						await authorizeGrantTarget(
							ctx,
							args.resource_type,
							args.resource_id,
						)
						const resolved = await resolveAuthorizedGrantPermissions(ctx, {
							resourceType: args.resource_type,
							preset: args.preset,
							permissions,
						})
						resourceType = args.resource_type
						resourceId = args.resource_id
						preset = args.preset ?? null
						if (preset) {
							permissions = null
						} else {
							permissions = [...resolved]
						}
						break
					}
					default: {
						const exhaustive: never = kind
						throw new Error(`Unknown invite kind: ${String(exhaustive)}`)
					}
				}
				const token = generateInviteToken()
				const tokenHash = await hashInviteToken(token)
				const created = await createInvite({
					db,
					orgId: request.org.id,
					kind,
					role,
					teamIds,
					resourceType,
					resourceId,
					preset,
					permissions,
					inviteeEmail: email,
					inviteeUsername: username,
					invitedByUserId: user.userId,
					tokenHash,
				})
				const invite = await getInviteById({
					db,
					orgId: request.org.id,
					inviteId: created.id,
				})
				if (!invite) throw new Error('Invite was not saved.')
				return {
					invite: toInvitePayload(invite, org.slug),
					token,
					prompt: inviteAcceptPrompt({ orgSlug: org.slug, token }),
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const inviteAcceptCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'inviteAccept',
		orgPermission: 'org:read',
		description:
			'Accept an invitation addressed to your account email or username. Pass the token from inviteCreate. Membership invites add you to that organization. Grant invites write the grant. The prompt from inviteCreate includes the organization slug and this call.',
		keywords: ['invite', 'accept', 'join', 'token'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			token: z.string().min(1),
		}),
		outputSchema: z.object({
			invite_id: z.string(),
			org_id: z.string(),
			org_slug: z.string(),
			kind: z.enum(['membership', 'grant']),
			status: z.literal('accepted'),
		}),
		async handler(args, ctx) {
			try {
				const { user, db } = await requireOrgPermission(ctx, 'org:read')
				const tokenHash = await hashInviteToken(args.token)
				const invite = await getInviteByTokenHash(db, tokenHash)
				if (
					!invite ||
					!(await timingSafeEqualString(invite.tokenHash, tokenHash))
				) {
					throw new McpCallerError('Invite token is not valid.')
				}
				if (invite.status === 'revoked') {
					throw new McpCallerError('This invite was revoked.')
				}
				if (invite.status === 'accepted') {
					throw new McpCallerError('This invite was already accepted.')
				}
				const expiresAtMs = Date.parse(invite.expiresAt)
				if (Number.isNaN(expiresAtMs)) {
					throw new Error(
						`Invite ${invite.id} has expires_at ${invite.expiresAt}.`,
					)
				}
				if (invite.status === 'expired' || expiresAtMs <= Date.now()) {
					if (invite.status === 'pending') {
						await markInviteExpired({ db, inviteId: invite.id })
					}
					throw new McpCallerError('This invite has expired.')
				}
				if (!inviteMatchesUser(invite, user)) {
					throw new McpCallerError(
						'This invite is addressed to a different email or username.',
					)
				}
				const org = await requireLiveOrg(db, invite.orgId)
				await acceptStoredInvite({
					db,
					env: ctx.env,
					invite,
					acceptedByUserId: user.userId,
				})
				return {
					invite_id: invite.id,
					org_id: invite.orgId,
					org_slug: org.slug,
					kind: invite.kind,
					status: 'accepted' as const,
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const inviteRevokeCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'inviteRevoke',
		orgPermission: 'none',
		description:
			'Revoke a pending invite in the organization this request is bound to. Membership invites need member:write. Grant invites need manage access on that resource (or member:write for an org grant). Accepted invites stay in place; remove the member or grant separately.',
		keywords: ['invite', 'revoke', 'cancel'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			invite_id: z.string().min(1),
		}),
		outputSchema: z.object({
			invite_id: z.string(),
			status: z.literal('revoked'),
		}),
		async handler(args, ctx) {
			try {
				const request = requireMcpRequest(ctx.callerContext)
				const db = ctx.env.APP_DB
				const invite = await getInviteById({
					db,
					orgId: request.org.id,
					inviteId: args.invite_id,
				})
				if (!invite) {
					throw new McpCallerError('Invite was not found in this organization.')
				}
				const kind = invite.kind
				switch (kind) {
					case 'membership':
						await authorize({ env: ctx.env, request }, 'member:write')
						break
					case 'grant': {
						if (!invite.resourceType || !invite.resourceId) {
							throw new McpCallerError(
								'This grant invite is missing a resource.',
							)
						}
						await authorizeGrantTarget(
							ctx,
							invite.resourceType,
							invite.resourceId,
						)
						break
					}
					default: {
						const exhaustive: never = kind
						throw new Error(`Unknown invite kind: ${String(exhaustive)}`)
					}
				}
				await markInviteRevoked({ db, inviteId: invite.id })
				return { invite_id: invite.id, status: 'revoked' as const }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)
