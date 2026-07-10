import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import { getEntitySourceByEntity } from '#worker/repo/entity-sources.ts'
import {
	assertPackageSourceOverwriteAllowed,
	assertPackagePrivateVisibilityChangeAllowed,
	defaultPackagePrivateGuidance,
	destructiveOverwriteConfirmationDescription,
	loadPriorPackageManifestContent,
	privateVisibilityChangeConfirmationDescription,
	productionPackageSourceSafetyPolicy,
} from '#worker/repo/source-safety-policy.ts'
import { injectDefaultPrivateField } from '#worker/package-registry/package-private.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
	insertSavedPackage,
} from '#worker/package-registry/repo.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { getMcpUserPackageScope } from '#worker/package-registry/user-scope.ts'
import { buildSavedPackageEmbedText } from '#worker/package-registry/embed.ts'
import { upsertSavedPackageVector } from '#worker/package-registry/vectorize.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
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
		confirm_destructive_overwrite: z
			.boolean()
			.optional()
			.default(false)
			.describe(destructiveOverwriteConfirmationDescription),
		confirm_private_visibility_change: z
			.boolean()
			.optional()
			.default(false)
			.describe(privateVisibilityChangeConfirmationDescription),
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

export function buildPackageSaveNextSteps(kodyId: string) {
	return [
		'Coding agents with local filesystem/git access should use the git lane for further edits instead of re-sending full file sets:',
		`call package_get_git_remote({ kody_id: ${JSON.stringify(kodyId)} }), run the returned setup_commands to clone into a temporary directory, edit and push normally, then publish with package_publish_external_push.`,
		'Binary assets and multi-file refactors are only supported through that git lane.',
		'Tool-only agents without local git can continue with package_save or repo sessions.',
	].join(' ')
}

export const savePackageCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_save',
		description: `Create or replace a saved package by writing a complete UTF-8 text file set (no binary assets). Coding agents with local filesystem/git access should prefer package_get_git_remote (pass create: true for new packages) to clone, edit, push, and publish with package_publish_external_push; tool-only agents use package_save or repo sessions. The package repo is rooted at package.json and package.json#kody is the Kody-specific metadata block. When creating or materially changing a package, include or maintain README.md with a concise Intent section that captures the user-defined goal; ask the user if intent is unclear. ${defaultPackagePrivateGuidance} ${productionPackageSourceSafetyPolicy}`,
		keywords: [
			'package',
			'save',
			'create',
			'update',
			'repo',
			'package.json',
			'readme',
			'intent',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema,
		outputSchema: packageSummarySchema.extend({
			next_steps: z
				.string()
				.describe(
					'Follow-up guidance for continuing package work, including the git clone-edit-push lane for coding agents.',
				),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			let files = normalizeFiles(args.files)
			let packageJsonContent = files['package.json']
			if (!packageJsonContent) {
				throw new Error('Saved packages require a root package.json file.')
			}
			const expectedPackageScope = await getMcpUserPackageScope(
				ctx.env.APP_DB,
				user,
			)
			const existing =
				args.package_id !== undefined
					? await getSavedPackageById(ctx.env.APP_DB, {
							userId: user.userId,
							packageId: args.package_id,
						})
					: await getSavedPackageByKodyId(ctx.env.APP_DB, {
							userId: user.userId,
							kodyId: parseAuthoredPackageJson({
								content: packageJsonContent,
								manifestPath: 'package.json',
								expectedPackageScope,
							}).kody.id,
						})
			if (!existing) {
				await assertWithinEntitlement({
					db: ctx.env.APP_DB,
					userId: user.userId,
					email: user.email,
					resource: 'saved_packages',
				})
				packageJsonContent = injectDefaultPrivateField(packageJsonContent)
				files = { ...files, 'package.json': packageJsonContent }
			}
			const manifest = parseAuthoredPackageJson({
				content: packageJsonContent,
				manifestPath: 'package.json',
				expectedPackageScope,
			})
			const packageId = existing?.id ?? args.package_id ?? crypto.randomUUID()
			const canonicalExistingSource =
				existing == null
					? null
					: await getEntitySourceByEntity(ctx.env.APP_DB, {
							userId: user.userId,
							entityKind: 'package',
							entityId: packageId,
						})
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
			const priorManifestContent =
				existing == null
					? null
					: await loadPriorPackageManifestContent({
							env: ctx.env,
							userId: user.userId,
							source:
								canonicalExistingSource?.id === ensuredSource.id
									? canonicalExistingSource
									: ensuredSource,
						})
			assertPackagePrivateVisibilityChangeAllowed({
				beforeContent: priorManifestContent,
				afterContent: packageJsonContent,
				isNewPackage: existing == null,
				operation: 'package_save',
				confirmed: args.confirm_private_visibility_change,
			})
			if (existing) {
				await assertPackageSourceOverwriteAllowed({
					env: ctx.env,
					userId: user.userId,
					source:
						canonicalExistingSource?.id === ensuredSource.id
							? canonicalExistingSource
							: ensuredSource,
					operation: 'package_save',
					confirmed: args.confirm_destructive_overwrite,
				})
			}
			await syncArtifactSourceSnapshot({
				env: ctx.env,
				userId: user.userId,
				baseUrl: ctx.callerContext.baseUrl,
				sourceId: ensuredSource.id,
				bootstrapAccess: ensuredSource.bootstrapAccess ?? null,
				files,
				destructiveOverwriteConfirmed: args.confirm_destructive_overwrite,
				privateVisibilityChangeConfirmed:
					args.confirm_private_visibility_change,
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
				next_steps: buildPackageSaveNextSteps(saved.kodyId),
			}
		},
	},
)
