import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { getMcpUserPackageScope } from '#worker/package-registry/user-scope.ts'
import {
	resolveArtifactDefaultBranchHead,
	resolveExistingArtifactSourceRepo,
} from '#worker/repo/artifacts.ts'
import { listPublishedBundleArtifactsBySourceId } from '#worker/repo/published-bundle-artifacts-repo.ts'
import { listRepoSessionsBySource } from '#worker/repo/repo-sessions.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { loadPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type RepoSessionRow } from '#worker/repo/types.ts'
import { resolveOwnedPackageSource } from './resolve-package-source.ts'

const recoverySourceSchema = z.object({
	kind: z.literal('repo_session'),
	session_id: z
		.string()
		.min(1)
		.describe(
			'Repo session id whose recorded checkpoint/base commit is trusted.',
		),
	commit: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional exact commit to recover. Defaults to the session checkpoint/base commit and must match entity_sources.published_commit.',
		),
})

const inputSchema = z.object({
	package_id: z.string().min(1).optional(),
	kody_id: z.string().min(1).optional(),
	action: z.enum(['inspect', 'recover']).default('inspect'),
	recovery_source: recoverySourceSchema.optional(),
	confirm_recovery: z
		.boolean()
		.default(false)
		.describe(
			'Required for action: recover. Confirms the operator wants Kody to recreate the missing default-branch HEAD from the verified source candidate.',
		),
	rebuild_package_artifacts: z
		.boolean()
		.default(true)
		.describe('Rebuild package bundle artifacts after a successful recovery.'),
})

const outputSchema = z.toJSONSchema(
	z.object({
		status: z.enum([
			'healthy',
			'recoverable',
			'blocked',
			'recovered',
			'checks_failed',
		]),
		package_id: z.string(),
		kody_id: z.string(),
		name: z.string(),
		source_id: z.string(),
		repo_id: z.string(),
		published_commit: z.string().nullable(),
		source_head: z
			.object({
				status: z.enum(['present', 'missing', 'repo_missing', 'error']),
				commit: z.string().nullable(),
				default_branch: z.string().nullable(),
				remote: z.string().nullable(),
				message: z.string().nullable(),
			})
			.optional(),
		source_snapshot: z.object({
			found: z.boolean(),
			file_count: z.number(),
			manifest_present: z.boolean(),
			message: z.string().nullable(),
		}),
		repo_session_candidates: z.array(
			z.object({
				session_id: z.string(),
				session_repo_id: z.string(),
				session_repo_name: z.string(),
				status: z.string(),
				base_commit: z.string(),
				last_checkpoint_commit: z.string().nullable(),
				recovered_commit: z.string().nullable(),
				matches_published_commit: z.boolean(),
				created_at: z.string(),
				updated_at: z.string(),
			}),
		),
		bundle_artifact_evidence: z.object({
			count_at_published_commit: z.number(),
			items: z.array(
				z.object({
					kind: z.string(),
					artifact_name: z.string().nullable(),
					entry_point: z.string(),
					kv_key: z.string(),
				}),
			),
			note: z.string(),
		}),
		recovery: z.unknown().optional(),
		recommended_next_action: z.string(),
	}),
) as Record<string, unknown>

function buildCandidate(
	session: RepoSessionRow,
	publishedCommit: string | null,
) {
	const recoveredCommit =
		publishedCommit != null &&
		session.last_checkpoint_commit === publishedCommit
			? session.last_checkpoint_commit
			: publishedCommit != null && session.base_commit === publishedCommit
				? session.base_commit
				: null
	return {
		session_id: session.id,
		session_repo_id: session.session_repo_id,
		session_repo_name: session.session_repo_name,
		status: session.status,
		base_commit: session.base_commit,
		last_checkpoint_commit: session.last_checkpoint_commit,
		recovered_commit: recoveredCommit,
		matches_published_commit: recoveredCommit != null,
		created_at: session.created_at,
		updated_at: session.updated_at,
	}
}

async function inspectSourceHead(env: Env, repoId: string) {
	try {
		const repo = await resolveExistingArtifactSourceRepo(env, repoId)
		if (!repo) {
			return {
				status: 'repo_missing' as const,
				commit: null,
				default_branch: null,
				remote: null,
				message: `Artifact source repo "${repoId}" was not found.`,
			}
		}
		const head = await resolveArtifactDefaultBranchHead({ repo })
		if (!head) {
			return {
				status: 'missing' as const,
				commit: null,
				default_branch: null,
				remote: null,
				message: `Artifact source repo "${repoId}" default branch has no HEAD.`,
			}
		}
		return {
			status: 'present' as const,
			commit: head.commit,
			default_branch: head.defaultBranch,
			remote: head.remote,
			message: null,
		}
	} catch (error) {
		return {
			status: 'error' as const,
			commit: null,
			default_branch: null,
			remote: null,
			message: error instanceof Error ? error.message : String(error),
		}
	}
}

async function inspectPublishedSourceSnapshot(input: {
	env: Env
	userId: string
	source: Parameters<typeof loadPublishedSourceSnapshot>[0]['source']
}) {
	try {
		const snapshot = await loadPublishedSourceSnapshot(input)
		if (!snapshot) {
			return {
				found: false,
				file_count: 0,
				manifest_present: false,
				message: 'No published source snapshot was found.',
			}
		}
		const files =
			typeof snapshot.files === 'object' && snapshot.files != null
				? snapshot.files
				: {}
		return {
			found: true,
			file_count: Object.keys(files).length,
			manifest_present: typeof files[input.source.manifest_path] === 'string',
			message: null,
		}
	} catch (error) {
		return {
			found: false,
			file_count: 0,
			manifest_present: false,
			message: error instanceof Error ? error.message : String(error),
		}
	}
}

export const sourceRescueCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_source_rescue',
		description:
			'Inspect and explicitly repair saved package source repos that fail normal package_get_git_remote/repo_open_session because the artifact source repo default branch has no HEAD. Recovery is non-destructive by default: it only restores an exact prior published commit from a verified repo session checkpoint/base commit, runs repo checks, records a source_rescue_events audit row, and leaves bundle artifacts as evidence rather than source.',
		keywords: [
			'package',
			'source',
			'rescue',
			'recover',
			'artifacts',
			'no head',
			'repo session',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const { packageId, kodyId, name, source } =
				await resolveOwnedPackageSource({
					db: ctx.env.APP_DB,
					userId: user.userId,
					args: {
						package_id: args.package_id,
						kody_id: args.kody_id,
					},
				})
			const [sourceHead, sourceSnapshot, sessions, bundleArtifacts] =
				await Promise.all([
					inspectSourceHead(ctx.env, source.repo_id),
					inspectPublishedSourceSnapshot({
						env: ctx.env,
						userId: user.userId,
						source,
					}),
					listRepoSessionsBySource(ctx.env.APP_DB, {
						userId: user.userId,
						sourceId: source.id,
					}),
					listPublishedBundleArtifactsBySourceId(
						ctx.env.APP_DB,
						user.userId,
						source.id,
					),
				])
			const candidates = sessions
				.map((session) => buildCandidate(session, source.published_commit))
				.filter((session) => session.matches_published_commit)
			const bundleEvidenceAtPublishedCommit = bundleArtifacts.filter(
				(artifact) => artifact.publishedCommit === source.published_commit,
			)
			const baseOutput = {
				package_id: packageId,
				kody_id: kodyId,
				name,
				source_id: source.id,
				repo_id: source.repo_id,
				published_commit: source.published_commit,
				source_head: sourceHead,
				source_snapshot: sourceSnapshot,
				repo_session_candidates: candidates,
				bundle_artifact_evidence: {
					count_at_published_commit: bundleEvidenceAtPublishedCommit.length,
					items: bundleEvidenceAtPublishedCommit
						.slice(0, 20)
						.map((artifact) => ({
							kind: artifact.artifactKind,
							artifact_name: artifact.artifactName,
							entry_point: artifact.entryPoint,
							kv_key: artifact.kvKey,
						})),
					note: 'Bundle artifacts are evidence only; package_source_rescue never recreates source from bundle output.',
				},
			}
			if (sourceHead.status === 'present' && args.action === 'inspect') {
				return {
					status: 'healthy' as const,
					...baseOutput,
					recommended_next_action:
						'Use normal package_get_git_remote, repo_open_session, or package_publish_external_push workflows.',
				}
			}
			if (args.action === 'inspect') {
				const recoverable =
					sourceHead.status === 'missing' && candidates.length > 0
				return {
					status: recoverable ? ('recoverable' as const) : ('blocked' as const),
					...baseOutput,
					recommended_next_action: recoverable
						? 'Call package_source_rescue with action: recover, confirm_recovery: true, and one listed repo_session candidate.'
						: 'No verified repo session checkpoint/base commit matches the prior published commit. Do not use package_save or bundle artifacts to recreate source; gather a verified source repo/session first.',
				}
			}
			if (sourceHead.status !== 'missing') {
				throw new Error(
					`package_source_rescue recover requires an existing source repo whose default branch has no HEAD; current status is "${sourceHead.status}".`,
				)
			}
			if (args.confirm_recovery !== true) {
				throw new Error(
					'package_source_rescue recover requires confirm_recovery: true after selecting a verified repo session candidate.',
				)
			}
			if (!args.recovery_source) {
				throw new Error(
					'package_source_rescue recover requires recovery_source.kind: "repo_session" and recovery_source.session_id.',
				)
			}
			const selectedSession = sessions.find(
				(session) => session.id === args.recovery_source?.session_id,
			)
			if (!selectedSession) {
				throw new Error(
					`Repo session "${args.recovery_source.session_id}" was not found for this package source.`,
				)
			}
			const selectedCandidate = candidates.find(
				(candidate) => candidate.session_id === selectedSession.id,
			)
			const selectedCommit =
				args.recovery_source.commit ?? selectedCandidate?.recovered_commit
			if (!selectedCommit || selectedCommit !== source.published_commit) {
				throw new Error(
					`Selected recovery commit "${selectedCommit ?? 'none'}" does not match prior published commit "${source.published_commit ?? 'none'}".`,
				)
			}
			if (!selectedCandidate) {
				throw new Error(
					`Repo session "${selectedSession.id}" is not a verified recovery candidate for the prior published commit.`,
				)
			}
			const expectedPackageScope = await getMcpUserPackageScope(
				ctx.env.APP_DB,
				user,
			)
			const recovery = await repoSessionRpc(
				ctx.env,
				selectedSession.id,
			).recoverSourceFromSessionCheckpoint({
				sessionId: selectedSession.id,
				sourceId: source.id,
				userId: user.userId,
				packageId,
				kodyId,
				recoveredCommit: selectedCommit,
				operatorUserId: user.userId,
				operatorEmail: user.email,
				baseUrl: ctx.callerContext.baseUrl,
				rebuildPackageArtifacts: args.rebuild_package_artifacts,
				expectedPackageScope,
			})
			const sourceHeadAfter =
				recovery.status === 'recovered'
					? {
							status: 'present' as const,
							commit: recovery.sourceHeadAfter,
							default_branch: sourceHead.default_branch,
							remote: sourceHead.remote,
							message: null,
						}
					: sourceHead
			return {
				status: recovery.status,
				...baseOutput,
				source_head: sourceHeadAfter,
				recovery,
				recommended_next_action:
					recovery.status === 'recovered'
						? 'Recovery restored the missing source HEAD. Normal package source workflows can be used again.'
						: 'Recovery did not publish because repo checks failed. Fix or select a different verified source candidate.',
			}
		},
	},
)
