import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import { listPackageCollaborators } from '#worker/orgs/package-collaborators.ts'
import {
	authorizeGrantTarget,
	grantPresetSchema,
	rethrowAccessError,
} from './shared.ts'

const collaboratorSchema = z.object({
	grant_id: z.string(),
	subject_type: z.enum(['user', 'team']),
	subject_id: z.string(),
	kind: z
		.enum(['team', 'member', 'outside'])
		.describe(
			'team: a team in this org. member: an org member. outside: holds this grant without membership.',
		),
	username: z.string().nullable(),
	display_name: z.string().nullable(),
	team_slug: z.string().nullable(),
	team_name: z.string().nullable(),
	preset: grantPresetSchema
		.nullable()
		.describe('Null for an advanced grant; see permissions.'),
	permissions: z.array(z.string()),
	created_at: z.string(),
})

const pendingInviteSchema = z.object({
	invite_id: z.string(),
	invitee_email: z.string().nullable(),
	invitee_username: z.string().nullable(),
	preset: grantPresetSchema.nullable(),
	permissions: z.array(z.string()).nullable(),
	expires_at: z.string(),
	created_at: z.string(),
})

export const packageCollaboratorListCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'packageCollaboratorList',
		orgPermission: 'none',
		description:
			'List who can use one package in the organization this request is bound to: teams, org members, and outside collaborators with their preset (Use, Contribute, or Manage) and grant_id, plus pending grant invites. package_id takes the package id or its kody id. You need manage access on the package. Change access with accessGrant (resource_type package, the returned package id; a second grant for the same subject replaces its preset), accessRevoke with a grant_id, inviteCreate with kind grant for someone outside the org, and inviteRevoke for a pending invite.',
		keywords: [
			'collaborators',
			'package',
			'access',
			'grant',
			'share',
			'who has access',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: z.string().min(1).describe('Package id or kody id.'),
		}),
		outputSchema: z.object({
			package: z.object({
				id: z.string(),
				kody_id: z.string(),
				name: z.string(),
			}),
			collaborators: z.array(collaboratorSchema),
			invites: z.array(pendingInviteSchema),
		}),
		async handler(args, ctx) {
			try {
				const request = requireMcpRequest(ctx.callerContext)
				const savedPackage = await resolveSavedPackage({
					db: ctx.env.APP_DB,
					userId: request.org.id,
					packageIdOrKodyId: args.package_id.trim(),
				})
				if (!savedPackage) {
					throw new McpCallerError(
						'Package was not found in this organization.',
					)
				}
				await authorizeGrantTarget(ctx, 'package', savedPackage.id)
				const listed = await listPackageCollaborators({
					db: ctx.env.APP_DB,
					orgId: request.org.id,
					packageId: savedPackage.id,
				})
				return {
					package: {
						id: savedPackage.id,
						kody_id: savedPackage.kodyId,
						name: savedPackage.name,
					},
					collaborators: listed.collaborators.map((collaborator) => ({
						grant_id: collaborator.grantId,
						subject_type: collaborator.subjectType,
						subject_id: collaborator.subjectId,
						kind: collaborator.kind,
						username: collaborator.username,
						display_name: collaborator.displayName,
						team_slug: collaborator.teamSlug,
						team_name:
							collaborator.subjectType === 'team' ? collaborator.label : null,
						preset: collaborator.preset,
						permissions: collaborator.permissions,
						created_at: collaborator.createdAt,
					})),
					invites: listed.invites.map((invite) => ({
						invite_id: invite.id,
						invitee_email: invite.inviteeEmail,
						invitee_username: invite.inviteeUsername,
						preset: invite.preset,
						permissions: invite.permissions,
						expires_at: invite.expiresAt,
						created_at: invite.createdAt,
					})),
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)
