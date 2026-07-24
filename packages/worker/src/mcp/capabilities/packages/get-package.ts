import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { resolvePublicUsername } from '#app/user-lookup.ts'
import { buildExternalPackageInvocationDescriptor } from '#worker/package-invocations/public-url.ts'
import { buildPackageSearchProjection } from '#worker/package-registry/manifest.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import {
	packageScopeInputDescription,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { packageDetailSchema } from './shared.ts'

export const getPackageCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_get',
		description:
			'Load one saved package metadata record for the signed-in user, including ready-to-import export specifiers and canonical owner-scoped external invocation URLs for each export.',
		keywords: [
			'package',
			'get',
			'read',
			'metadata',
			'exports',
			'imports',
			'invocation url',
			'package invocation token',
		],
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
				ctx.env.APP_DB,
				user,
				args.package_scope,
			)
			const saved = await getSavedPackageById(ctx.env.APP_DB, {
				userId: owner.ownerUserId,
				packageId: args.package_id,
			})
			if (!saved) {
				throw new McpCallerError('Saved package not found for this user.')
			}
			const username = await resolvePublicUsername({
				db: ctx.env.APP_DB,
				username: owner.ownerScope,
				email: owner.ownerEmail,
			})
			const loaded = await loadPackageManifestBySourceId({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: owner.ownerUserId,
				sourceId: saved.sourceId,
			})
			const projection = buildPackageSearchProjection(loaded.manifest)
			return {
				package_id: saved.id,
				kody_id: saved.kodyId,
				name: saved.name,
				description: saved.description,
				tags: saved.tags,
				has_app: saved.hasApp,
				hidden: saved.hidden,
				source_id: saved.sourceId,
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
					external_invocation: username
						? (() => {
								const descriptor = buildExternalPackageInvocationDescriptor({
									baseUrl: ctx.callerContext.baseUrl,
									ownerUsername: username,
									kodyId: saved.kodyId,
									exportName: exportDetail.subpath,
								})
								return {
									method: descriptor.method,
									url: descriptor.url,
									path: descriptor.path,
									owner_username: descriptor.ownerUsername,
									kody_id: descriptor.kodyId,
									route_export_name: descriptor.routeExportName,
									normalized_export_name: descriptor.normalizedExportName,
									token_setup_url: descriptor.tokenSetupUrl,
									source_guidance: descriptor.sourceGuidance,
								}
							})()
						: null,
				})),
			}
		},
	},
)
