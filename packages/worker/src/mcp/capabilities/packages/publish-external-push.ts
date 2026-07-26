import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	errorCauseChainIncludes,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	getStaticPackageDependentsSummary,
	type StaticPackageDependentsSummary,
} from '#worker/package-runtime/static-package-dependents.ts'
import {
	packageScopeInputDescription,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { rebuildPublishedPackageArtifactsViaRepoSession } from '#mcp/capabilities/repo/package-artifact-rebuild.ts'
import { destructiveOverwriteConfirmationDescription } from '#worker/repo/source-safety-policy.ts'
import {
	buildPendingPackageSecretApprovalsSummary,
	type PendingPackageSecretApprovalsSummary,
} from '#mcp/secrets/pending-package-secret-approvals.ts'
import { loadPublishedEntitySource } from '#worker/repo/published-source.ts'
import { pendingPackageSecretApprovalsSchema } from './shared.ts'
import { resolveOwnedPackageSource } from './resolve-package-source.ts'

const inputSchema = z.object({
	package_id: z.string().min(1).optional(),
	kody_id: z.string().min(1).optional(),
	package_scope: z
		.string()
		.min(1)
		.optional()
		.describe(packageScopeInputDescription),
	allow_force: z.boolean().optional().default(false),
	confirm_destructive_overwrite: z
		.boolean()
		.optional()
		.default(false)
		.describe(destructiveOverwriteConfirmationDescription),
})

const externalPublishRetryDelaysMs = [100, 500] as const

function isTransientDurableObjectResetError(error: unknown) {
	return errorCauseChainIncludes(
		error,
		(message) =>
			message.includes('Durable Object exceeded its CPU time limit') ||
			message.includes("Durable Object's isolate exceeded its memory limit") ||
			message.includes('Durable Object was reset'),
	)
}

function logExternalPublishRetry(input: {
	sourceId: string
	repoId: string
	packageId: string
	newCommit: string
	attempt: number
	nextDelayMs: number
	error: unknown
}) {
	// Log-only: DO isolate memory/CPU resets are retried; do not open Sentry
	// issues per attempt. Exhausted retries still throw and hit MCP observability.
	const errorMessage = getErrorMessage(input.error)
	console.warn(
		JSON.stringify({
			message: 'package_publish_external_push transient Durable Object reset',
			sourceId: input.sourceId,
			repoId: input.repoId,
			packageId: input.packageId,
			newCommit: input.newCommit,
			attempt: input.attempt,
			nextDelayMs: input.nextDelayMs,
			errorMessage,
		}),
	)
}

async function delay(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

const checkSchema = z.object({
	kind: z.enum([
		'manifest',
		'dependencies',
		'bundle',
		'typecheck',
		'lint',
		'smoke',
	]),
	ok: z.boolean(),
	message: z.string(),
})

const staticDependentItemSchema = z
	.object({
		package_id: z
			.string()
			.describe('Saved package id of the dependent package.'),
		kody_id: z
			.string()
			.describe('User-scoped kody.id of the dependent package.'),
		name: z
			.string()
			.describe('Scoped package.json name of the dependent package.'),
		source_id: z
			.string()
			.describe('Repo-backed source id for the dependent package.'),
		published_commit: z
			.string()
			.nullable()
			.describe('Current published commit of the dependent package.'),
		stale: z
			.boolean()
			.describe(
				"True when at least one dependent bundle artifact captured a dependency commit that differs from the package's current published commit.",
			),
		artifact_count: z
			.number()
			.int()
			.nonnegative()
			.describe(
				'Number of published bundle artifacts that reference this dependency.',
			),
		entrypoints: z
			.array(z.string())
			.describe(
				'Bounded list of dependent bundle entrypoints referencing this dependency.',
			),
		entrypoints_truncated: z
			.boolean()
			.describe(
				'True when the dependent has more matching entrypoints than returned.',
			),
		bundled_dependency_commit: z
			.string()
			.nullable()
			.describe(
				'Dependency commit captured in the dependent bundle, or null when matching artifacts have mixed or missing commits.',
			),
		current_dependency_commit: z
			.string()
			.describe(
				'Current published commit for the referenced dependency package.',
			),
		recommended_action: z
			.string()
			.describe('Agent guidance for this dependent package.'),
	})
	.describe('A direct static dependent package from persisted bundle metadata.')

const staticDependentsSchema = z
	.object({
		total: z
			.number()
			.int()
			.nonnegative()
			.describe('Total direct static dependent packages found.'),
		stale: z
			.number()
			.int()
			.nonnegative()
			.describe(
				'Count of direct static dependent packages with stale bundled snapshots.',
			),
		truncated: z
			.boolean()
			.describe(
				'True when more dependent packages exist than are returned in items.',
			),
		items: z
			.array(staticDependentItemSchema)
			.describe('Bounded direct static dependent package summaries.'),
		recommended_next_action: z
			.string()
			.describe(
				'Agent guidance explaining whether to inspect or republish dependents. Kody does not republish dependents automatically.',
			),
	})
	.describe(
		'Bounded summary of saved packages whose published bundles statically captured this package through kody:@ imports.',
	)

const outputSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('already_published'),
		published_commit: z.string().nullable(),
		static_dependents: staticDependentsSchema,
		pending_secret_package_approvals: pendingPackageSecretApprovalsSchema,
	}),
	z.object({
		status: z.literal('not_fast_forward'),
		previous_commit: z.string(),
		published_commit: z.string(),
		message: z.string(),
	}),
	z.object({
		status: z.literal('checks_failed'),
		failed_checks: z.array(checkSchema),
		manifest: z.unknown(),
		run_id: z.string(),
	}),
	z.object({
		status: z.literal('published'),
		previous_commit: z.string().nullable(),
		published_commit: z.string(),
		manifest: z.unknown(),
		checks: z.array(checkSchema),
		static_dependents: staticDependentsSchema,
		pending_secret_package_approvals: pendingPackageSecretApprovalsSchema,
	}),
])

function readSecretMountsFromPackageJson(content: string | undefined) {
	if (!content) return null
	try {
		const parsed = JSON.parse(content) as {
			kody?: {
				secretMounts?: Record<
					string,
					{ name: string; scope?: 'user' | 'package' | 'session' }
				>
			}
		}
		const mounts = parsed.kody?.secretMounts
		if (!mounts || typeof mounts !== 'object') return null
		return mounts
	} catch {
		return null
	}
}

async function getPendingSecretApprovalsForPublishedPackage(input: {
	env: Env
	baseUrl: string
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
}): Promise<PendingPackageSecretApprovalsSummary | null> {
	try {
		const published = await loadPublishedEntitySource({
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
		})
		return await buildPendingPackageSecretApprovalsSummary({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			packageId: input.packageId,
			kodyId: input.kodyId,
			secretMounts: readSecretMountsFromPackageJson(
				published.files['package.json'],
			),
			files: published.files,
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: input.packageId,
				storageId: null,
			},
		})
	} catch {
		return null
	}
}

async function getPublishStaticDependents(input: {
	db: D1Database
	userId: string
	sourceId: string
	publishedCommit: string | null
}): Promise<StaticPackageDependentsSummary> {
	if (!input.publishedCommit) {
		return {
			total: 0,
			stale: 0,
			truncated: false,
			items: [],
			recommended_next_action:
				'No published commit is available, so static dependent bundle metadata cannot be compared.',
		}
	}
	return await getStaticPackageDependentsSummary({
		db: input.db,
		userId: input.userId,
		sourceId: input.sourceId,
		currentDependencyCommit: input.publishedCommit,
	})
}

export const publishExternalPushCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_publish_external_push',
		description:
			'Publish the current Artifacts git HEAD for a saved package after a package_get_git_remote clone/edit/push workflow and server-side checks pass. Non-fast-forward publishes require explicit destructive overwrite confirmation and a verified restorable backup snapshot. Published and already_published responses include bounded static dependent metadata so agents can decide whether stale kody:@ bundled snapshots need inspection or dependent republish; Kody does not republish dependents automatically.',
		keywords: ['package', 'publish', 'git', 'artifacts', 'external', 'push'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(
				ctx.env.APP_DB,
				user,
				args.package_scope,
			)
			const expectedPackageScope = owner.ownerScope
			const maxAttempts = externalPublishRetryDelaysMs.length + 1
			let lastTransientError: unknown = null
			for (
				let attemptIndex = 0;
				attemptIndex < maxAttempts;
				attemptIndex += 1
			) {
				const attempt = attemptIndex + 1
				const { packageId, kodyId, source } = await resolveOwnedPackageSource({
					db: ctx.env.APP_DB,
					userId: owner.ownerUserId,
					args: {
						package_id: args.package_id,
						kody_id: args.kody_id,
					},
				})
				const head = await resolveArtifactSourceHead(ctx.env, source.repo_id)
				const newCommit = head.commit
				if (!newCommit) {
					throw new Error(
						`Artifacts repo "${source.repo_id}" has no published HEAD to reconcile.`,
					)
				}
				const sessionId =
					attemptIndex === 0
						? `external-publish-${source.id}`
						: `external-publish-${source.id}-retry-${attempt}`
				try {
					const result = await repoSessionRpc(
						ctx.env,
						sessionId,
					).publishFromExternalRef({
						sessionId,
						sourceId: source.id,
						userId: owner.ownerUserId,
						newCommit,
						expectedHead: newCommit,
						allowForce: args.allow_force,
						destructiveOverwriteConfirmed: args.confirm_destructive_overwrite,
						baseUrl: ctx.callerContext.baseUrl,
						rebuildPackageArtifacts: false,
						expectedPackageScope,
					})
					if (result.status === 'already_published') {
						if (!result.published_commit) {
							throw new Error(
								`Package "${packageId}" is already published, but no published commit is available to rebuild artifacts.`,
							)
						}
						await rebuildPublishedPackageArtifactsViaRepoSession({
							env: ctx.env,
							rpcSessionId: sessionId,
							sourceId: source.id,
							userId: owner.ownerUserId,
							publishedCommit: result.published_commit,
							baseUrl: ctx.callerContext.baseUrl,
						})
						return {
							...result,
							static_dependents: await getPublishStaticDependents({
								db: ctx.env.APP_DB,
								userId: owner.ownerUserId,
								sourceId: source.id,
								publishedCommit: result.published_commit,
							}),
							pending_secret_package_approvals:
								await getPendingSecretApprovalsForPublishedPackage({
									env: ctx.env,
									baseUrl: ctx.callerContext.baseUrl,
									userId: owner.ownerUserId,
									packageId,
									kodyId,
									sourceId: source.id,
								}),
						} as const
					}
					if (result.status !== 'published') {
						return result
					}
					await rebuildPublishedPackageArtifactsViaRepoSession({
						env: ctx.env,
						rpcSessionId: sessionId,
						sourceId: source.id,
						userId: owner.ownerUserId,
						publishedCommit: result.published_commit,
						baseUrl: ctx.callerContext.baseUrl,
					})
					return {
						...result,
						static_dependents: await getPublishStaticDependents({
							db: ctx.env.APP_DB,
							userId: owner.ownerUserId,
							sourceId: source.id,
							publishedCommit: result.published_commit,
						}),
						pending_secret_package_approvals:
							await getPendingSecretApprovalsForPublishedPackage({
								env: ctx.env,
								baseUrl: ctx.callerContext.baseUrl,
								userId: owner.ownerUserId,
								packageId,
								kodyId,
								sourceId: source.id,
							}),
					} as const
				} catch (error) {
					if (!isTransientDurableObjectResetError(error)) {
						throw error
					}
					lastTransientError = error
					const willRetry = attemptIndex < externalPublishRetryDelaysMs.length
					const nextDelayMs = willRetry
						? (externalPublishRetryDelaysMs[attemptIndex] ?? 0)
						: 0
					logExternalPublishRetry({
						sourceId: source.id,
						repoId: source.repo_id,
						packageId,
						newCommit,
						attempt,
						nextDelayMs,
						error,
					})
					if (!willRetry) {
						break
					}
					await delay(nextDelayMs)
				}
			}
			throw new Error(
				`package_publish_external_push could not recover after ${maxAttempts} transient Durable Object reset attempts: ${getErrorMessage(
					lastTransientError,
				)}`,
			)
		},
	},
)
