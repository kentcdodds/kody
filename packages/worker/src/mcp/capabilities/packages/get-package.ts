import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { buildPackageSearchProjection } from '#worker/package-registry/manifest.ts'
import { buildPackageImportSpecifier } from '#worker/package-registry/package-import-specifier.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { packageDetailSchema } from './shared.ts'

export const getPackageCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_get',
		description:
			'Load one saved package metadata record for the signed-in user, including ready-to-import export specifiers.',
		keywords: ['package', 'get', 'read', 'metadata', 'exports', 'imports'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: z.string().min(1),
		}),
		outputSchema: packageDetailSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const saved = await getSavedPackageById(ctx.env.APP_DB, {
				userId: user.userId,
				packageId: args.package_id,
			})
			if (!saved) {
				throw new Error('Saved package not found for this user.')
			}
			const loaded = await loadPackageManifestBySourceId({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: user.userId,
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
				})),
			}
		},
	},
)
