import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { buildSavedPackageEmbedText } from '#worker/package-registry/embed.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
	insertSavedPackage,
} from '#worker/package-registry/repo.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { assertKodyDescriptionLength } from '#worker/package-registry/types.ts'
import { upsertSavedPackageVector } from '#worker/package-registry/vectorize.ts'
import { getMcpUserPackageScope } from '#worker/package-registry/user-scope.ts'
import { readArtifactFileAtCommit } from '#worker/repo/artifact-file.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { updateEntitySource } from '#worker/repo/entity-sources.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { deleteUserRepo } from '#worker/repo/user-repos.ts'
import { resolveOwnedUserRepo } from './resolve-user-repo.ts'

const repoIdentitySchema = z
	.object({
		repo_id: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
	})
	.superRefine((value, ctx) => {
		const count =
			(value.repo_id !== undefined ? 1 : 0) + (value.name !== undefined ? 1 : 0)
		if (count !== 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['repo_id'],
				message: 'Provide exactly one of `repo_id` or `name`.',
			})
		}
	})

export const repoPromoteToPackageCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_promote_to_package',
		description:
			'Promote a package-shaped plain repo (root package.json at HEAD) into a saved package. Runs the full external-push publish checks; on success creates the saved-package projection and removes the plain-repo row.',
		keywords: ['repo', 'promote', 'package', 'activate'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: repoIdentitySchema,
		outputSchema: z.object({
			status: z.literal('promoted'),
			package_id: z.string(),
			kody_id: z.string(),
			name: z.string(),
			published_commit: z.string(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const { userRepo, source } = await resolveOwnedUserRepo({
				db: ctx.env.APP_DB,
				userId: user.userId,
				args,
			})
			if (source.entity_kind !== 'repo') {
				const existingPackage = await getSavedPackageById(ctx.env.APP_DB, {
					userId: user.userId,
					packageId: source.entity_id,
				})
				if (existingPackage) {
					throw new McpCallerError(
						`Plain repo "${userRepo.name}" was already promoted to saved package "${existingPackage.kodyId}".`,
					)
				}
				throw new McpCallerError(
					'This source is no longer a plain repo and cannot be promoted.',
				)
			}
			const head = await resolveArtifactSourceHead(ctx.env, source.repo_id)
			if (!head.commit) {
				throw new McpCallerError(
					`Plain repo "${userRepo.name}" has no commits yet. Add a root package.json and push before promoting.`,
				)
			}
			const packageJsonBytes = await readArtifactFileAtCommit({
				env: ctx.env,
				repoId: source.repo_id,
				commit: head.commit,
				filePath: 'package.json',
			})
			if (!packageJsonBytes) {
				throw new McpCallerError(
					`Plain repo "${userRepo.name}" is not package-shaped: root package.json was not found at HEAD.`,
				)
			}
			const packageScope = await getMcpUserPackageScope(ctx.env.APP_DB, user)
			let manifest: ReturnType<typeof parseAuthoredPackageJson>
			try {
				manifest = parseAuthoredPackageJson({
					content: new TextDecoder().decode(packageJsonBytes),
					manifestPath: 'package.json',
					expectedPackageScope: packageScope,
				})
				assertKodyDescriptionLength(manifest.kody.description)
			} catch (error) {
				throw new McpCallerError(getErrorMessage(error), { cause: error })
			}
			const kodyIdCollision = await getSavedPackageByKodyId(ctx.env.APP_DB, {
				userId: user.userId,
				kodyId: manifest.kody.id,
			})
			if (kodyIdCollision) {
				throw new McpCallerError(
					`A saved package with kody id "${manifest.kody.id}" already exists. Change package.json#kody.id in the repo before promoting.`,
				)
			}
			await assertWithinEntitlement({
				db: ctx.env.APP_DB,
				userId: user.userId,
				email: user.email,
				resource: 'saved_packages',
			})
			const sessionId = `repo-promote-${source.id}-${crypto.randomUUID()}`
			const session = repoSessionRpc(ctx.env, sessionId)
			await session.openSession({
				sessionId,
				sourceId: source.id,
				userId: user.userId,
				baseUrl: ctx.callerContext.baseUrl,
			})
			const checkRun = await session.runChecks({
				sessionId,
				userId: user.userId,
				expectedPackageScope: packageScope,
			})
			if (!checkRun.ok) {
				await session
					.discardSession({ sessionId, userId: user.userId })
					.catch(() => undefined)
				const failed = checkRun.results
					.filter((entry) => !entry.ok)
					.map((entry) => entry.message)
					.join('\n')
				throw new McpCallerError(
					failed || 'Publish checks failed for the package-shaped plain repo.',
				)
			}
			const packageId = crypto.randomUUID()
			const now = new Date().toISOString()
			await insertSavedPackage(ctx.env.APP_DB, {
				id: packageId,
				user_id: user.userId,
				name: manifest.name,
				kody_id: manifest.kody.id,
				description: manifest.kody.description,
				tags_json: JSON.stringify(manifest.kody.tags ?? []),
				search_text: manifest.kody.searchText ?? null,
				source_id: source.id,
				has_app: manifest.kody.app !== undefined ? 1 : 0,
				hidden: 0,
				is_private: manifest.private === true ? 1 : 0,
				created_at: now,
				updated_at: now,
			})
			await updateEntitySource(ctx.env.APP_DB, {
				id: source.id,
				userId: user.userId,
				entityKind: 'package',
				entityId: packageId,
				manifestPath: 'package.json',
				sourceRoot: source.source_root,
			})
			const publishResult = await session.publishSession({
				sessionId,
				userId: user.userId,
				expectedPackageScope: packageScope,
			})
			if (publishResult.status !== 'ok') {
				await ctx.env.APP_DB.prepare(
					`DELETE FROM saved_packages WHERE user_id = ? AND id = ?`,
				)
					.bind(user.userId, packageId)
					.run()
				await updateEntitySource(ctx.env.APP_DB, {
					id: source.id,
					userId: user.userId,
					entityKind: 'repo',
					entityId: userRepo.id,
					// Restore the exact pre-promotion columns so a failed promote
					// leaves the entity source byte-identical to its prior state.
					manifestPath: source.manifest_path,
					sourceRoot: source.source_root,
				})
				await session
					.discardSession({ sessionId, userId: user.userId })
					.catch(() => undefined)
				throw new McpCallerError(
					publishResult.message || 'Failed to publish promoted package source.',
				)
			}
			// Best-effort projections after the publish committed: a vector or
			// search-projection failure must not strand a half-promoted repo.
			// Reindex lanes converge both later.
			await upsertSavedPackageVector(ctx.env, {
				packageId,
				userId: user.userId,
				embedText: buildSavedPackageEmbedText(manifest),
			}).catch(() => undefined)
			await refreshSavedPackageProjection({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: user.userId,
				packageId,
				sourceId: source.id,
			}).catch(() => undefined)
			await deleteUserRepo(ctx.env.APP_DB, {
				userId: user.userId,
				repoId: userRepo.id,
			})
			return {
				status: 'promoted' as const,
				package_id: packageId,
				kody_id: manifest.kody.id,
				name: manifest.name,
				published_commit: publishResult.publishedCommit,
			}
		},
	},
)
