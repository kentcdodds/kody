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
				'When true, lock publishes so later agent publishes need a website click. Agents can lock but cannot unlock; send the owner to /account/packages/:packageId to unlock.',
			),
	})
	.refine(
		(changes) => changes.hidden !== undefined || changes.locked !== undefined,
		{
			message: 'Provide at least one supported package change.',
		},
	)

export const packageUpdateCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_update',
		description:
			'Update mutable settings for a saved package. Supports hidden search-discovery state and locking publishes (`changes.locked: true`). Agents cannot unlock; send the owner to /account/packages/:packageId. Canonical package metadata such as name, description, tags, kody id, app projection, and source remains derived from package.json and must change through package save or publish.',
		keywords: ['package', 'update', 'hidden', 'visibility', 'search', 'lock'],
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
							packageId: args.package_id,
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
