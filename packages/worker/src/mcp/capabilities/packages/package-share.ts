import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	acceptPackageShare,
	acknowledgePackageShareUpdate,
	defaultPackageShareTrustLevel,
	getPackageShareGrantById,
	grantIsAddressedToGuest,
	hydratePackageShareGrantViews,
	requireHydratedPackageShareGrantView,
	invitePackageShare,
	leavePackageShare,
	listInboundPackageShareGrants,
	listOutboundPackageShareGrants,
	listPackageShareGrantsByPackageId,
	packageShareAccessErrorMessage,
	revokePackageShare,
	type PackageShareGrantRow,
	type PackageShareGrantView,
} from '#worker/package-registry/share-grants.ts'
import {
	getSavedPackageById,
	getSavedPackageByName,
} from '#worker/package-registry/repo.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import { isAccountEmailVerified } from '#worker/identity/email-verification-state.ts'
import { sendPackageShareInviteEmail } from '#worker/package-registry/share-invite-email.ts'
import { packageShareGrantsFlagKey } from '#worker/package-registry/share-flag.ts'
import { assertSharePinAcknowledgeReview } from '#worker/package-registry/share-pin-review.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	packageShareGrantSchema,
	packageShareTrustLevelSchema,
	toPackageShareGrantPayload,
} from './package-share-shared.ts'

async function resolveOwnerSavedPackage(input: {
	db: D1Database
	ownerUserId: string
	packageId?: string
	name?: string
}): Promise<SavedPackageRecord> {
	if (input.packageId) {
		const saved = await getSavedPackageById(input.db, {
			userId: input.ownerUserId,
			packageId: input.packageId,
		})
		if (!saved) {
			throw new McpCallerError(
				'Saved package not found for this user. Only the package owner can manage share grants.',
			)
		}
		return saved
	}
	if (input.name) {
		const saved = await getSavedPackageByName(input.db, {
			userId: input.ownerUserId,
			name: input.name,
		})
		if (!saved) {
			throw new McpCallerError(
				`Saved package "${input.name}" was not found for this user.`,
			)
		}
		return saved
	}
	throw new McpCallerError('Provide package name or package_id.')
}

async function hydrateGrants(
	db: D1Database,
	grants: Array<PackageShareGrantRow>,
): Promise<Array<PackageShareGrantView>> {
	return await hydratePackageShareGrantViews(db, grants)
}

async function inboundShareGrantLookup(
	db: D1Database,
	user: ReturnType<typeof requireMcpUser>,
) {
	return {
		userId: user.userId,
		email: user.email,
		emailVerified: await isAccountEmailVerified({
			db,
			email: user.email,
			stableUserId: user.userId,
		}),
	}
}

function throwShareError(error: unknown): never {
	throw new McpCallerError(packageShareAccessErrorMessage(error))
}

export const packageShareInviteCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageShareInvite',
		featureFlag: packageShareGrantsFlagKey,
		description:
			'Invite a person by username or email to use one of your saved packages. They must accept before the package is attached. Guests can read source and invoke; they cannot publish or write. Both accounts must be on a paid plan.',
		keywords: ['share', 'invite', 'package share', 'guest', 'collaborate'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			name: z
				.string()
				.min(1)
				.optional()
				.describe('Scoped package name, for example @alice/shared-notes.'),
			package_id: z.string().min(1).optional(),
			username: z.string().min(1).optional(),
			email: z.string().min(1).optional(),
		}),
		outputSchema: z.object({ grant: packageShareGrantSchema }),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			try {
				const saved = await resolveOwnerSavedPackage({
					db: ctx.env.APP_DB,
					ownerUserId: user.userId,
					packageId: args.package_id,
					name: args.name,
				})
				const grant = await invitePackageShare({
					db: ctx.env.APP_DB,
					owner: user,
					packageId: saved.id,
					invitee: { username: args.username, email: args.email },
				})
				await sendPackageShareInviteEmail({
					env: ctx.env,
					requestUrl: ctx.callerContext.baseUrl,
					grant,
				})
				return {
					grant: toPackageShareGrantPayload(
						await requireHydratedPackageShareGrantView({
							db: ctx.env.APP_DB,
							grant,
						}),
					),
				}
			} catch (error) {
				throwShareError(error)
			}
		},
	},
)

export const packageShareAcceptCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageShareAccept',
		featureFlag: packageShareGrantsFlagKey,
		description:
			'Accept a pending package share invitation. Default trust_level is pin (safer): use and import fail closed if the owner publishes ahead until you approve the diff. follow auto-accepts future publishes.',
		keywords: ['share', 'accept', 'invite', 'pin', 'follow'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			grant_id: z.string().min(1).optional(),
			package_id: z.string().min(1).optional(),
			name: z.string().min(1).optional(),
			trust_level: packageShareTrustLevelSchema.optional(),
		}),
		outputSchema: z.object({ grant: packageShareGrantSchema }),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			try {
				let packageId = args.package_id
				if (!args.grant_id && !packageId && args.name) {
					const inbound = await listInboundPackageShareGrants(ctx.env.APP_DB, {
						...(await inboundShareGrantLookup(ctx.env.APP_DB, user)),
					})
					const views = await hydrateGrants(ctx.env.APP_DB, inbound)
					const match = views.find((view) => view.packageName === args.name)
					packageId = match?.packageId
				}
				const grant = await acceptPackageShare({
					db: ctx.env.APP_DB,
					guest: user,
					grantId: args.grant_id,
					packageId,
					trustLevel: args.trust_level ?? defaultPackageShareTrustLevel,
				})
				return {
					grant: toPackageShareGrantPayload(
						await requireHydratedPackageShareGrantView({
							db: ctx.env.APP_DB,
							grant,
						}),
					),
				}
			} catch (error) {
				throwShareError(error)
			}
		},
	},
)

export const packageShareRevokeCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageShareRevoke',
		featureFlag: packageShareGrantsFlagKey,
		description:
			'Revoke a package share grant you own. New invokes and imports fail immediately. In-flight worker isolates may finish.',
		keywords: ['share', 'revoke', 'unshare'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			grant_id: z.string().min(1),
		}),
		outputSchema: z.object({ grant: packageShareGrantSchema }),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			try {
				const grant = await revokePackageShare({
					db: ctx.env.APP_DB,
					ownerUserId: user.userId,
					grantId: args.grant_id,
				})
				return {
					grant: toPackageShareGrantPayload(
						await requireHydratedPackageShareGrantView({
							db: ctx.env.APP_DB,
							grant,
						}),
					),
				}
			} catch (error) {
				throwShareError(error)
			}
		},
	},
)

export const packageShareLeaveCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageShareLeave',
		featureFlag: packageShareGrantsFlagKey,
		description:
			'Leave a package that was shared with you. Your own packages keep existing imports, but the next call into the left package fails.',
		keywords: ['share', 'leave', 'unshare'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			grant_id: z.string().min(1),
		}),
		outputSchema: z.object({ grant: packageShareGrantSchema }),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			try {
				const grant = await leavePackageShare({
					db: ctx.env.APP_DB,
					granteeUserId: user.userId,
					grantId: args.grant_id,
				})
				return {
					grant: toPackageShareGrantPayload(
						await requireHydratedPackageShareGrantView({
							db: ctx.env.APP_DB,
							grant,
						}),
					),
				}
			} catch (error) {
				throwShareError(error)
			}
		},
	},
)

export const packageShareListCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageShareList',
		featureFlag: packageShareGrantsFlagKey,
		description:
			'List package share grants: outbound (what you shared), inbound (shared with you, including pending email invites), or by one owned package.',
		keywords: ['share', 'list', 'shared with me', 'invitations'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			scope: z.enum(['outbound', 'inbound', 'package']).default('inbound'),
			name: z.string().min(1).optional(),
			package_id: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			grants: z.array(packageShareGrantSchema),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			try {
				const scope = args.scope
				switch (scope) {
					case 'outbound':
						return {
							grants: (
								await hydrateGrants(
									ctx.env.APP_DB,
									await listOutboundPackageShareGrants(
										ctx.env.APP_DB,
										user.userId,
									),
								)
							).map(toPackageShareGrantPayload),
						}
					case 'inbound':
						return {
							grants: (
								await hydrateGrants(
									ctx.env.APP_DB,
									await listInboundPackageShareGrants(ctx.env.APP_DB, {
										...(await inboundShareGrantLookup(ctx.env.APP_DB, user)),
									}),
								)
							).map(toPackageShareGrantPayload),
						}
					case 'package': {
						const saved = await resolveOwnerSavedPackage({
							db: ctx.env.APP_DB,
							ownerUserId: user.userId,
							packageId: args.package_id,
							name: args.name,
						})
						return {
							grants: (
								await hydrateGrants(
									ctx.env.APP_DB,
									await listPackageShareGrantsByPackageId(
										ctx.env.APP_DB,
										saved.id,
									),
								)
							).map(toPackageShareGrantPayload),
						}
					}
					default: {
						const exhaustive: never = scope
						throw new Error(`Unknown share list scope: ${String(exhaustive)}`)
					}
				}
			} catch (error) {
				throwShareError(error)
			}
		},
	},
)

export const packageShareInspectCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageShareInspect',
		featureFlag: packageShareGrantsFlagKey,
		description:
			'Inspect one package share grant you own or that is addressed to you, including pin-ahead state and the approve-changes path.',
		keywords: ['share', 'inspect', 'grant', 'pin'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			grant_id: z.string().min(1),
		}),
		outputSchema: z.object({ grant: packageShareGrantSchema }),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			try {
				const grant = await getPackageShareGrantById(
					ctx.env.APP_DB,
					args.grant_id,
				)
				const emailVerified = await isAccountEmailVerified({
					db: ctx.env.APP_DB,
					email: user.email,
					stableUserId: user.userId,
				})
				if (
					!grant ||
					(grant.ownerUserId !== user.userId &&
						!grantIsAddressedToGuest(
							grant,
							user.userId,
							normalizeEmailAddress(user.email ?? ''),
							emailVerified,
						))
				) {
					throw new McpCallerError('Share grant not found for this user.')
				}
				return {
					grant: toPackageShareGrantPayload(
						await requireHydratedPackageShareGrantView({
							db: ctx.env.APP_DB,
							grant,
						}),
					),
				}
			} catch (error) {
				if (error instanceof McpCallerError) throw error
				throwShareError(error)
			}
		},
	},
)

export const packageShareAcknowledgeUpdateCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageShareAcknowledgeUpdate',
		featureFlag: packageShareGrantsFlagKey,
		description:
			'Approve one reviewed published commit of a pin-trust shared package after inspecting the accepted-to-current diff. Pin approval requires published_commit. Optionally switch to follow.',
		keywords: ['share', 'approve', 'acknowledge', 'pin', 'follow'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			grant_id: z.string().min(1),
			published_commit: z.string().min(1).optional(),
			switch_to_follow: z.boolean().optional(),
		}),
		outputSchema: z.object({ grant: packageShareGrantSchema }),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			try {
				await assertSharePinAcknowledgeReview({
					env: ctx.env,
					db: ctx.env.APP_DB,
					granteeUserId: user.userId,
					grantId: args.grant_id,
					switchToFollow: args.switch_to_follow,
					expectedPublishedCommit: args.published_commit,
				})
				const grant = await acknowledgePackageShareUpdate({
					db: ctx.env.APP_DB,
					granteeUserId: user.userId,
					grantId: args.grant_id,
					switchToFollow: args.switch_to_follow,
					expectedPublishedCommit: args.published_commit,
				})
				return {
					grant: toPackageShareGrantPayload(
						await requireHydratedPackageShareGrantView({
							db: ctx.env.APP_DB,
							grant,
						}),
					),
				}
			} catch (error) {
				throwShareError(error)
			}
		},
	},
)
