import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
	insertSavedPackage,
} from '#worker/package-registry/repo.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { buildSavedPackageEmbedText } from '#worker/package-registry/embed.ts'
import { upsertSavedPackageVector } from '#worker/package-registry/vectorize.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { packageFileSchema, packageSummarySchema } from './shared.ts'

const inputSchema = z
	.object({
		package_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional saved package id to update in place. Omit to create a new saved package.',
			),
		files: z
			.array(packageFileSchema)
			.min(1)
			.describe(
				'Full package file set to write. Must include package.json at the repo root.',
			),
	})
	.superRefine((value, ctx) => {
		const hasPackageJson = value.files.some(
			(file) => file.path.trim().replace(/^\.?\//, '') === 'package.json',
		)
		if (!hasPackageJson) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['files'],
				message: 'Saved packages require a root package.json file.',
			})
		}
	})

function normalizeFiles(files: Array<z.infer<typeof packageFileSchema>>) {
	const next: Record<string, string> = {}
	for (const file of files) {
		const normalizedPath = file.path.trim().replace(/^\.?\//, '')
		next[normalizedPath] = file.content.trimEnd() + '\n'
	}
	return next
}

export const savePackageCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_save',
		description:
			'Create or replace a saved package for the signed-in user. The package repo is rooted at package.json and package.json#kody is the Kody-specific metadata block.',
		keywords: ['package', 'save', 'create', 'update', 'repo', 'package.json'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema: packageSummarySchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const files = normalizeFiles(args.files)
			const packageJsonContent = files['package.json']
			if (!packageJsonContent) {
				throw new Error('Saved packages require a root package.json file.')
			}
			const manifest = parseAuthoredPackageJson({
				content: packageJsonContent,
				manifestPath: 'package.json',
			})
			const existing =
				args.package_id !== undefined
					? await getSavedPackageById(ctx.env.APP_DB, {
							userId: user.userId,
							packageId: args.package_id,
						})
					: await getSavedPackageByKodyId(ctx.env.APP_DB, {
							userId: user.userId,
							kodyId: manifest.kody.id,
						})
			const packageId = existing?.id ?? args.package_id ?? crypto.randomUUID()
			const ensuredSource = await ensureEntitySource({
				db: ctx.env.APP_DB,
				env: ctx.env,
				userId: user.userId,
				entityKind: 'package',
				entityId: packageId,
				sourceRoot: '/',
				manifestPath: 'package.json',
				requirePersistence: true,
			})
			await syncArtifactSourceSnapshot({
				env: ctx.env,
				userId: user.userId,
				baseUrl: ctx.callerContext.baseUrl,
				sourceId: ensuredSource.id,
				bootstrapAccess: ensuredSource.bootstrapAccess ?? null,
				files,
			})
			if (!existing) {
				const now = new Date().toISOString()
				await insertSavedPackage(ctx.env.APP_DB, {
					id: packageId,
					user_id: user.userId,
					name: manifest.name,
					kody_id: manifest.kody.id,
					description: manifest.kody.description,
					tags_json: JSON.stringify(manifest.kody.tags ?? []),
					search_text: manifest.kody.searchText ?? null,
					source_id: ensuredSource.id,
					has_app: manifest.kody.app ? 1 : 0,
					created_at: now,
					updated_at: now,
				})
				await upsertSavedPackageVector(ctx.env, {
					packageId,
					userId: user.userId,
					embedText: buildSavedPackageEmbedText(manifest),
				})
			}
			const refreshed = await refreshSavedPackageProjection({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: user.userId,
				packageId,
				sourceId: ensuredSource.id,
			})
			const saved = refreshed.record
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
			}
		},
	},
)
