import * as Sentry from '@sentry/cloudflare'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import {
	hasPublishedRuntimeArtifacts,
	writePublishedSourceSnapshot,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { getEntitySourceById, updateEntitySource } from './entity-sources.ts'
import { runRepoChecks } from './checks.ts'
import {
	type EntitySourceRow,
	type RepoExternalPublishResult,
} from './types.ts'

export type RepoPublishWorkspace = {
	readFile(path: string): Promise<string | null>
	glob(pattern: string): Promise<Array<{ path: string; type: string }>>
}

export type FinalizePublishedSourceInput = {
	env: Env
	source: EntitySourceRow
	publishedCommit: string
	files: Record<string, string>
	baseUrl?: string
}

export async function finalizePublishedEntitySource(
	input: FinalizePublishedSourceInput,
) {
	const previousPublishedCommit = input.source.published_commit
	await updateEntitySource(input.env.APP_DB, {
		id: input.source.id,
		userId: input.source.user_id,
		publishedCommit: input.publishedCommit,
		manifestPath: input.source.manifest_path,
		sourceRoot: input.source.source_root,
	})
	if (hasPublishedRuntimeArtifacts(input.env)) {
		try {
			await writePublishedSourceSnapshot({
				env: input.env,
				source: {
					...input.source,
					published_commit: input.publishedCommit,
				},
				files: input.files,
			})
		} catch (snapshotError) {
			try {
				await updateEntitySource(input.env.APP_DB, {
					id: input.source.id,
					userId: input.source.user_id,
					publishedCommit: previousPublishedCommit,
					manifestPath: input.source.manifest_path,
					sourceRoot: input.source.source_root,
				})
			} catch (revertError) {
				Sentry.captureException(revertError, {
					tags: {
						scope: 'repo.publishFromExternalRef.revert-after-snapshot-failure',
					},
					extra: {
						sourceId: input.source.id,
						previousPublishedCommit,
						attemptedPublishedCommit: input.publishedCommit,
					},
				})
			}
			throw snapshotError
		}
	}
	if (input.source.entity_kind === 'package') {
		try {
			await refreshSavedPackageProjection({
				env: input.env,
				baseUrl: input.baseUrl ?? input.source.source_root,
				userId: input.source.user_id,
				packageId: input.source.entity_id,
				sourceId: input.source.id,
			})
		} catch (projectionError) {
			Sentry.captureException(projectionError, {
				tags: {
					scope: 'repo.publishFromExternalRef.refresh-package-projection',
				},
				extra: {
					sourceId: input.source.id,
					packageId: input.source.entity_id,
					publishedCommit: input.publishedCommit,
				},
			})
			console.warn('publish_from_external_ref projection refresh failed', {
				sourceId: input.source.id,
				packageId: input.source.entity_id,
				publishedCommit: input.publishedCommit,
				error:
					projectionError instanceof Error
						? projectionError.message
						: String(projectionError),
			})
		}
	}
}

export async function publishFromExternalRef(input: {
	env: Env
	sourceId: string
	userId: string
	newCommit: string
	isFastForward(input: { previousCommit: string }): Promise<boolean>
	allowForce?: boolean
	workspace: RepoPublishWorkspace
	files: Record<string, string>
	baseUrl: string
	manifestPath?: string
	sourceRoot?: string
	runId?: string
}): Promise<RepoExternalPublishResult> {
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source || source.user_id !== input.userId) {
		throw new Error('Repo source was not found for this user.')
	}
	if (source.published_commit === input.newCommit) {
		return {
			status: 'already_published',
			published_commit: source.published_commit,
		}
	}
	if (
		source.published_commit &&
		!input.allowForce &&
		!(await input.isFastForward({
			previousCommit: source.published_commit,
		}))
	) {
		return {
			status: 'not_fast_forward',
			previous_commit: source.published_commit,
			published_commit: input.newCommit,
			message:
				'The external Artifacts HEAD is not a descendant of the current published commit. Retry with allow_force to publish it.',
		}
	}
	const checks = await runRepoChecks({
		workspace: input.workspace,
		manifestPath: input.manifestPath ?? source.manifest_path,
		sourceRoot: input.sourceRoot ?? source.source_root,
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
	})
	const runId = input.runId ?? crypto.randomUUID()
	if (!checks.ok) {
		return {
			status: 'checks_failed',
			failed_checks: checks.results.filter((check) => !check.ok),
			manifest: checks.manifest,
			run_id: runId,
		}
	}
	await finalizePublishedEntitySource({
		env: input.env,
		source,
		publishedCommit: input.newCommit,
		files: input.files,
		baseUrl: input.baseUrl,
	})
	return {
		status: 'published',
		previous_commit: source.published_commit,
		published_commit: input.newCommit,
		manifest: checks.manifest,
		checks: checks.results,
	}
}
