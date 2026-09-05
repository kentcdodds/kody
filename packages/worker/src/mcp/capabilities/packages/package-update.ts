import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	packageScopeInputDescription,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import {
	buildPackageUnlockUrl,
	createPackageUnlockRequiredMessage,
	isSavedPackageLocked,
} from '#worker/package-registry/package-publish-lock.ts'
import {
	getSavedPackageById,
	setSavedPackageLockedAt,
	updateSavedPackage,
} from '#worker/package-registry/repo.ts'
import {
	publishCommunityListing,
	unpublishCommunityListing,
} from '#worker/community/service.ts'
import { getCommunityListingByOwnerAndPackage } from '#worker/community/repo.ts'
import { packageSummarySchema, toPackageSummary } from './shared.ts'

const packageUpdateChangesSchema = z
	.strictObject({
		hidden: z
			.boolean()
			.optional()
			.describe(
				'When true, hide the package from ranked search discovery by default.',
			),
		locked: z
			.boolean()
			.optional()
			.describe(
				'When true, lock publishes so later agent publishes need a website click. Agents can lock but cannot unlock; send the owner to the package page (/@{username}/{kodyId}) to unlock.',
			),
		visibility: z
			.enum(['public', 'private'])
			.optional()
			.describe(
				'Repo visibility. Public means default-branch HEAD is world-readable and forkable and the package appears on /community. Before setting public, review the package for overly personal content (package_authoring visibility). If anything looks personal, stop, tell the user, suggest generalizing, and wait for explicit go-ahead. Private is owner-only. Changing to private unlists the catalog entry; existing forks keep their copies.',
			),
	})
	.refine(
		(changes) =>
			changes.hidden !== undefined ||
			changes.locked !== undefined ||
			changes.visibility !== undefined,
		{
			message: 'Provide at least one supported package change.',
		},
	)

export const packageUpdateCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageUpdate',
		description:
			'Update mutable settings for a saved package: hidden search-discovery, publish lock (`changes.locked: true`; agents cannot unlock), and repo visibility (`changes.visibility`). Making a package public lists it on /community with full source and fork. Before setting visibility public, review source, README, Intent, description, tags, examples, and hardcoded identifiers for overly personal material. If anything looks personal or household-specific, do not publish yet — tell the user what you found, suggest how to generalize, and wait for explicit go-ahead. No MIT, logo, or Intent platform gates. Making it private unlists it (public URLs 404; forks keep their copies) — pass confirm_name matching the package slug after the owner typed that name. Canonical package metadata such as name, description, and tags remains derived from package.json. Visibility is not package.json#private.',
		keywords: [
			'package',
			'update',
			'hidden',
			'visibility',
			'public',
			'private',
			'search',
			'lock',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.strictObject({
			package_id: z.string().min(1).describe('Saved package id.'),
			package_scope: z
				.string()
				.min(1)
				.optional()
				.describe(packageScopeInputDescription),
			changes: packageUpdateChangesSchema,
			confirm_name: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Required when changes.visibility is private. Must equal the package slug (URL name). Confirm with the user first: going private 404s public URLs and unlists the catalog; existing forks keep their copies.',
				),
		}),
		outputSchema: z.object({
			ok: z.literal(true),
			package: packageSummarySchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(
				ctx.env,
				user,
				args.package_scope,
			)
			const existing = await getSavedPackageById(ctx.env.APP_DB, {
				userId: owner.ownerUserId,
				packageId: args.package_id,
			})
			if (!existing) {
				throw new McpCallerError('Saved package not found for this user.')
			}
			if (args.changes.locked === false) {
				throw new McpCallerError(
					createPackageUnlockRequiredMessage(
						buildPackageUnlockUrl({
							baseUrl: ctx.callerContext.baseUrl,
							username: owner.ownerScope,
							kodyId: existing.kodyId,
						}),
					),
				)
			}
			if (args.changes.hidden !== undefined) {
				const changed = await updateSavedPackage(ctx.env.APP_DB, {
					userId: owner.ownerUserId,
					packageId: args.package_id,
					hidden: args.changes.hidden,
				})
				if (!changed) {
					throw new McpCallerError('Saved package not found for this user.')
				}
			}
			if (
				args.changes.locked === true &&
				!isSavedPackageLocked(existing.lockedAt)
			) {
				const locked = await setSavedPackageLockedAt(ctx.env.APP_DB, {
					userId: owner.ownerUserId,
					packageId: args.package_id,
					lockedAt: new Date().toISOString(),
				})
				if (!locked) {
					throw new McpCallerError('Saved package not found for this user.')
				}
			}
			if (args.changes.visibility === 'public' && existing.isPrivate) {
				await publishCommunityListing({
					env: ctx.env,
					baseUrl: ctx.callerContext.baseUrl,
					userId: owner.ownerUserId,
					actorUserId: owner.actorUserId,
					packageId: args.package_id,
				})
			}
			if (args.changes.visibility === 'private' && !existing.isPrivate) {
				const expectedName = existing.kodyId
				if (args.confirm_name?.trim() !== expectedName) {
					throw new McpCallerError(
						`Making this package private unlists it from /community and 404s public URLs. Existing forks keep their copies. Confirm with the user, then pass confirm_name: "${expectedName}" (the package slug).`,
					)
				}
				const listing = await getCommunityListingByOwnerAndPackage(
					ctx.env.APP_DB,
					{
						ownerUserId: owner.ownerUserId,
						packageId: args.package_id,
					},
				)
				if (listing && listing.status === 'active') {
					await unpublishCommunityListing({
						env: ctx.env,
						userId: owner.ownerUserId,
						actorUserId: owner.actorUserId,
						listingId: listing.id,
					})
				} else {
					const changed = await updateSavedPackage(ctx.env.APP_DB, {
						userId: owner.ownerUserId,
						packageId: args.package_id,
						isPrivate: true,
					})
					if (!changed) {
						throw new McpCallerError('Saved package not found for this user.')
					}
				}
			}
			const savedPackage = await getSavedPackageById(ctx.env.APP_DB, {
				userId: owner.ownerUserId,
				packageId: args.package_id,
			})
			if (!savedPackage) {
				throw new McpCallerError('Saved package not found for this user.')
			}
			return {
				ok: true as const,
				package: toPackageSummary(savedPackage),
			}
		},
	},
)
