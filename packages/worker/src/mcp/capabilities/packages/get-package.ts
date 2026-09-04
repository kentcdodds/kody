import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { buildPackageSearchProjection } from '#worker/package-registry/manifest.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import {
	packageScopeInputDescription,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import { getSavedPackageWithCommunityProvenanceById } from '#worker/package-registry/repo.ts'
import {
	buildPlainRepoPromotionErrorMessage,
	findPlainRepoPromotionHint,
} from '#worker/repo/user-repos.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { packageDetailSchema } from './shared.ts'

export const getPackageCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageGet',
		description:
			'Load one saved package metadata record for the signed-in user, including community-fork source listing provenance, ready-to-import export specifiers, and callable export contracts.',
		keywords: ['package', 'get', 'read', 'metadata', 'exports', 'imports'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: z.string().min(1),
			package_scope: z
				.string()
				.min(1)
				.optional()
				.describe(packageScopeInputDescription),
		}),
		outputSchema: packageDetailSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(
				ctx.env,
				user,
				args.package_scope,
			)
			const saved = await getSavedPackageWithCommunityProvenanceById(
				ctx.env.APP_DB,
				{
					userId: owner.ownerUserId,
					packageId: args.package_id,
				},
			)
			if (!saved) {
				const plainRepo = await findPlainRepoPromotionHint(ctx.env.APP_DB, {
					userId: owner.ownerUserId,
					packageIdOrKodyId: args.package_id,
				})
				if (plainRepo) {
					throw new McpCallerError(
						buildPlainRepoPromotionErrorMessage(args.package_id),
					)
				}
				throw new McpCallerError('Saved package not found for this user.')
			}
			const loaded = await loadPackageSourceBySourceId({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: owner.ownerUserId,
				sourceId: saved.sourceId,
			})
			const projection = buildPackageSearchProjection(
				loaded.manifest,
				loaded.files,
			)
			return {
				package_id: saved.id,
				kody_id: saved.kodyId,
				name: saved.name,
				description: saved.description,
				tags: saved.tags,
				has_app: saved.hasApp,
				hidden: saved.hidden,
				visibility: saved.isPrivate
					? ('private' as const)
					: ('public' as const),
				locked_at: saved.lockedAt ?? null,
				source_id: saved.sourceId,
				source_listing_id: saved.sourceListingId,
				listing_current: saved.listingCurrent,
				listing_kody_id: saved.listingKodyId,
				listing_name: saved.listingName,
				origin_commit: saved.originCommit,
				listing_pinned_commit: saved.listingPinnedCommit,
				listing_published_at: saved.listingPublishedAt,
				listing_ahead: saved.listingAhead,
				created_at: saved.createdAt,
				updated_at: saved.updatedAt,
				exports: (projection.exports ?? []).map((exportDetail) => ({
					subpath: exportDetail.subpath,
					import_specifier: buildPackageImportSpecifier(
						saved.name,
						exportDetail.subpath,
					),
					runtime_target: exportDetail.runtimeTarget,
					types_path: exportDetail.typesPath,
					description: exportDetail.description,
					type_definition: exportDetail.typeDefinition,
					functions: (exportDetail.functions ?? []).map((exportedFunction) => ({
						name: exportedFunction.name,
						description: exportedFunction.description,
						type_definition: exportedFunction.typeDefinition,
					})),
					referenced_types: (exportDetail.referencedTypes ?? []).map(
						(referencedType) => ({
							name: referencedType.name,
							kind: referencedType.kind,
							definition: referencedType.definition,
						}),
					),
				})),
			}
		},
	},
)
