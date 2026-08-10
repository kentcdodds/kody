import { z } from 'zod'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import { getEntitySourceByEntity } from '#worker/repo/entity-sources.ts'
import {
	buildRepoLargeFileMessage,
	findOversizedRepoSourceFile,
} from '#worker/repo/large-file-policy.ts'
import {
	assertPackageSourceOverwriteAllowed,
	assertPackagePrivateVisibilityChangeAllowed,
	defaultPackagePrivateGuidance,
	destructiveOverwriteConfirmationDescription,
	isDestructiveOverwriteConfirmationMessage,
	isPrivateVisibilityChangeConfirmationMessage,
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
import { assertKodyDescriptionLength } from '#worker/package-registry/types.ts'
import {
	packageScopeInputDescription,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { reportCapabilityProgress } from '#mcp/progress.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import {
	buildPendingPackageSecretApprovalsSummary,
	formatPendingPackageSecretApprovalsGuidance,
} from '#mcp/secrets/pending-package-secret-approvals.ts'
import {
	packageFileSchema,
	packageSummarySchema,
	pendingPackageSecretApprovalsSchema,
} from './shared.ts'

function parseSavedPackageManifest(input: {
	content: string
	expectedPackageScope: string
}) {
	try {
		const manifest = parseAuthoredPackageJson({
			content: input.content,
			manifestPath: 'package.json',
			expectedPackageScope: input.expectedPackageScope,
		})
		assertKodyDescriptionLength(manifest.kody.description)
		return manifest
	} catch (error) {
		// Caller-authored package.json mistakes (wrong kody.dependencies shape,
		// scope mismatches, etc.) — keep them off Sentry via McpCallerError.
		throw new McpCallerError(getErrorMessage(error), { cause: error })
	}
}

const inputSchema = z
	.object({
		package_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional saved package id to update in place. Omit to create a new saved package.',
			),
		package_scope: z
			.string()
			.min(1)
			.optional()
			.describe(packageScopeInputDescription),
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

export function buildPackageSaveNextSteps(input: {
	kodyId: string
	pendingSecretApprovalsGuidance?: string | null
}) {
	const steps = [
		'Coding agents with local filesystem/git access should use the git lane for further edits instead of re-sending full file sets:',
		`call package_get_git_remote({ kody_id: ${JSON.stringify(input.kodyId)} }), run the returned setup_commands to clone into a temporary directory, edit and push normally, then publish with package_publish_external_push.`,
		'Binary assets and multi-file refactors are only supported through that git lane.',
		'Tool-only agents without local git can continue with package_save or repo sessions.',
	]
	const guidance = input.pendingSecretApprovalsGuidance?.trim()
	if (guidance) {
		steps.push(guidance)
	}
	return steps.join(' ')
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
					'Follow-up guidance for continuing package work, including the git clone-edit-push lane for coding agents and any pending package secret approvals.',
				),
			pending_secret_package_approvals: pendingPackageSecretApprovalsSchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(
				ctx.env,
				user,
				args.package_scope,
			)
			let files = normalizeFiles(args.files)
			let packageJsonContent = files['package.json']
			if (!packageJsonContent) {
				throw new McpCallerError(
					'Saved packages require a root package.json file.',
				)
			}
			const expectedPackageScope = owner.ownerScope
			const existing =
				args.package_id !== undefined
					? await getSavedPackageById(ctx.env.APP_DB, {
							userId: owner.ownerUserId,
							packageId: args.package_id,
						})
					: await getSavedPackageByKodyId(ctx.env.APP_DB, {
							userId: owner.ownerUserId,
							kodyId: parseSavedPackageManifest({
								content: packageJsonContent,
								expectedPackageScope,
							}).kody.id,
						})
			if (!existing) {
				await assertWithinEntitlement({
					db: ctx.env.APP_DB,
					userId: owner.ownerUserId,
					email: owner.ownerEmail,
					resource: 'saved_packages',
				})
				packageJsonContent = injectDefaultPrivateField(packageJsonContent)
				files = { ...files, 'package.json': packageJsonContent }
			}
			// Gate on the final file set (after injectDefaultPrivateField) so the
			// exact bytes handed to syncArtifactSourceSnapshot are what was checked.
			const oversizedFile = findOversizedRepoSourceFile(Object.entries(files))
			if (oversizedFile) {
				throw new McpCallerError(buildRepoLargeFileMessage(oversizedFile))
			}
			const manifest = parseSavedPackageManifest({
				content: packageJsonContent,
				expectedPackageScope,
			})
			const packageId = existing?.id ?? args.package_id ?? crypto.randomUUID()
			const canonicalExistingSource =
				existing == null
					? null
					: await getEntitySourceByEntity(ctx.env.APP_DB, {
							userId: owner.ownerUserId,
							entityKind: 'package',
							entityId: packageId,
						})
			const ensuredSource = await ensureEntitySource({
				db: ctx.env.APP_DB,
				env: ctx.env,
				userId: owner.ownerUserId,
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
							userId: owner.ownerUserId,
							source:
								canonicalExistingSource?.id === ensuredSource.id
									? canonicalExistingSource
									: ensuredSource,
						})
			try {
				assertPackagePrivateVisibilityChangeAllowed({
					beforeContent: priorManifestContent,
					afterContent: packageJsonContent,
					isNewPackage: existing == null,
					operation: 'package_save',
					confirmed: args.confirm_private_visibility_change,
				})
			} catch (error) {
				const message = getErrorMessage(error)
				if (isPrivateVisibilityChangeConfirmationMessage(message)) {
					throw new McpCallerError(message, { cause: error })
				}
				throw error
			}
			if (existing) {
				try {
					await assertPackageSourceOverwriteAllowed({
						env: ctx.env,
						userId: owner.ownerUserId,
						source:
							canonicalExistingSource?.id === ensuredSource.id
								? canonicalExistingSource
								: ensuredSource,
						operation: 'package_save',
						confirmed: args.confirm_destructive_overwrite,
					})
				} catch (error) {
					const message = getErrorMessage(error)
					// Shared policy helpers throw plain Errors; reclassify the
					// confirmation gate so agents see McpCallerError and Sentry
					// does not open platform-bug issues (KODY issue 7661329778).
					if (isDestructiveOverwriteConfirmationMessage(message)) {
						throw new McpCallerError(message, { cause: error })
					}
					throw error
				}
			}
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 1,
				total: 4,
				message: 'Syncing your package source — filing bits into the vault…',
			})
			await syncArtifactSourceSnapshot({
				env: ctx.env,
				userId: owner.ownerUserId,
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
					user_id: owner.ownerUserId,
					name: manifest.name,
					kody_id: manifest.kody.id,
					description: manifest.kody.description,
					tags_json: JSON.stringify(manifest.kody.tags ?? []),
					search_text: manifest.kody.searchText ?? null,
					source_id: ensuredSource.id,
					has_app: manifest.kody.app ? 1 : 0,
					hidden: 0,
					is_private: manifest.private === true ? 1 : 0,
					created_at: now,
					updated_at: now,
				})
			}
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 2,
				total: 4,
				message:
					'Publishing the saved-package projection — jobs, artifacts, and a tidy D1 row…',
			})
			const refreshed = await refreshSavedPackageProjection({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: owner.ownerUserId,
				packageId,
				sourceId: ensuredSource.id,
				waitUntil: ctx.waitUntil,
			})
			const saved = refreshed.record
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 3,
				total: 4,
				message: 'Checking pending secret approvals — no spoilers, just gates…',
			})
			const pendingSecretApprovals =
				await buildPendingPackageSecretApprovalsSummary({
					env: ctx.env,
					baseUrl: ctx.callerContext.baseUrl,
					userId: owner.ownerUserId,
					packageId: saved.id,
					kodyId: saved.kodyId,
					secretMounts: manifest.kody.secretMounts,
					files,
					storageContext: {
						sessionId: null,
						appId: null,
						packageId: saved.id,
						storageId: null,
					},
				})
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 4,
				total: 4,
				message: 'Package save complete — ready when you are.',
			})
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
				pending_secret_package_approvals: pendingSecretApprovals,
				next_steps: buildPackageSaveNextSteps({
					kodyId: saved.kodyId,
					pendingSecretApprovalsGuidance: pendingSecretApprovals
						? formatPendingPackageSecretApprovalsGuidance(
								pendingSecretApprovals,
							)
						: null,
				}),
			}
		},
	},
)
