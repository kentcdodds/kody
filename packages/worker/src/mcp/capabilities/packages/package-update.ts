import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { authorizePackageWrite } from '#worker/authorization/authorize.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
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
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import {
	clearInternetVisible,
	loadCapabilityApprovalSummary,
} from '#worker/package-capabilities/capability-approval-service.ts'
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
				'Repo visibility / forkable. Public means default-branch HEAD is world-readable and forkable and the package appears on /community. Before setting public, review the package for overly personal content (package_authoring visibility). If anything looks personal, stop, tell the user, suggest generalizing, and wait for explicit go-ahead. Private is owner-only. Changing to private unlists the catalog entry; existing forks keep their copies. Independent of internet_visible.',
			),
		internet_visible: z
			.boolean()
			.optional()
			.describe(
				'Internet-visible app serving. Independent of visibility/forkable. Agents cannot approve capabilities: setting true returns an approval_url for the owner website. Setting false turns off public app serving (requires confirm_name).',
			),
	})
	.refine(
		(changes) =>
			changes.hidden !== undefined ||
			changes.locked !== undefined ||
			changes.visibility !== undefined ||
			changes.internet_visible !== undefined,
		{
			message: 'Provide at least one supported package change.',
		},
	)

export const packageUpdateCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageUpdate',
		orgPermission: 'package:write',
		description:
			'Update mutable settings for a saved package: hidden search-discovery, publish lock (`changes.locked: true`; agents cannot unlock), repo visibility / forkable (`changes.visibility`), and internet-visible app serving (`changes.internet_visible`). Making a package public lists it on /community with full source and fork. Before setting visibility public, review source, README, Intent, description, tags, examples, and hardcoded identifiers for overly personal material. If anything looks personal or household-specific, do not publish yet — tell the user what you found, suggest how to generalize, and wait for explicit go-ahead. No MIT, logo, or Intent platform gates. Making it private unlists it (public URLs 404; forks keep their copies) — pass confirm_name matching the package slug after the owner typed that name. Internet-visible is independent of forkable and requires owner capability approval on the website. Canonical package metadata such as name, description, and tags remains derived from package.json. Visibility is not package.json#private.',
		keywords: [
			'package',
			'update',
			'hidden',
			'visibility',
			'public',
			'private',
			'forkable',
			'internet-visible',
			'search',
			'lock',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.strictObject({
			package_id: z.string().min(1).describe('Saved package id.'),
			changes: packageUpdateChangesSchema,
			confirm_name: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Required when changes.visibility is private or changes.internet_visible is false. Must equal the package slug (URL name). Confirm with the user first.',
				),
		}),
		outputSchema: z.object({
			ok: z.literal(true),
			package: packageSummarySchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const existing = await getSavedPackageById(ctx.env.APP_DB, {
				userId: owner.ownerUserId,
				packageId: args.package_id,
			})
			if (!existing) {
				throw new McpCallerError('Saved package not found for this user.')
			}
			await authorizePackageWrite(
				{ env: ctx.env, request: ctx.callerContext.request },
				{
					id: existing.id,
					userId: existing.userId,
					label: existing.name,
				},
			)
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

			if (
				args.changes.internet_visible === true &&
				!existing.isInternetVisible
			) {
				const approvalUrl = buildPackageCapabilityApprovalUrl({
					baseUrl: ctx.callerContext.baseUrl,
					username: owner.ownerScope,
					kodyId: existing.kodyId,
				})
				const summary = await loadCapabilityApprovalSummary({
					env: ctx.env,
					ownerUserId: owner.ownerUserId,
					savedPackage: existing,
					requestUrl: ctx.callerContext.baseUrl,
				})
				if (!summary.publishedCommit) {
					throw new McpCallerError(
						`Publish the package before making it internet-visible. Then send the owner to approve capabilities: ${approvalUrl}`,
					)
				}
				if (!summary.fingerprintMatchesApproval) {
					throw new McpCallerError(
						`Internet-visible requires owner approval of the credential and capability summary. Send them to ${approvalUrl}`,
					)
				}
				const changed = await updateSavedPackage(ctx.env.APP_DB, {
					userId: owner.ownerUserId,
					packageId: args.package_id,
					isInternetVisible: true,
				})
				if (!changed) {
					throw new McpCallerError('Saved package not found for this user.')
				}
			}
			if (
				args.changes.internet_visible === false &&
				existing.isInternetVisible
			) {
				const expectedName = existing.kodyId
				if (args.confirm_name?.trim() !== expectedName) {
					throw new McpCallerError(
						`Turning off internet-visible returns the app to owner-session serving. Confirm with the user, then pass confirm_name: "${expectedName}" (the package slug).`,
					)
				}
				const changed = await clearInternetVisible({
					env: ctx.env,
					ownerUserId: owner.ownerUserId,
					packageId: args.package_id,
				})
				if (!changed) {
					throw new McpCallerError('Saved package not found for this user.')
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
