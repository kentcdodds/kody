import { writePublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { writeArtifactSourceSnapshot } from './artifact-source-snapshot.ts'
import {
	getArtifactsBinding,
	isArtifactRepoNotFoundError,
	isLoopbackArtifactsRemote,
	resolveExistingArtifactSourceRepo,
	type ArtifactBootstrapAccess,
	type ArtifactCreateRepoResult,
} from './artifacts.ts'
import { updateEntitySource } from './entity-sources.ts'
import { syncArtifactSourceSnapshot } from './source-sync.ts'
import { type EntitySourceRow } from './types.ts'
import {
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'

export async function forkArtifactRepo(input: {
	env: Env
	sourceRepoId: string
	targetRepoId: string
}): Promise<ArtifactCreateRepoResult> {
	const binding = getArtifactsBinding(input.env)
	return await binding.fork(input.sourceRepoId, input.targetRepoId, {
		readOnly: false,
		defaultBranchOnly: true,
	})
}

/**
 * After a storage-layer Artifacts fork, rewrite only the changed files.
 *
 * Loopback remotes (local mock) have no real git object store: the copied
 * mock snapshot is overwritten with the already-rewritten Worker tree so
 * dest contents match production's "fork + small commit" outcome without
 * opening a RepoSession.
 *
 * Production remotes apply `changedFiles` only through the existing-source
 * session path (applyEdits + publish). The origin tree is already in the
 * dest repo; binaries never become `Record<path, string>` RPC edits.
 */
export async function persistForkedArtifactRepoContents(input: {
	env: Env
	baseUrl: string
	userId: string
	source: EntitySourceRow
	originCommit: string
	changedFiles: Record<string, string>
	files: Record<string, string>
	bootstrapAccess?: ArtifactBootstrapAccess | null
	serverTiming?: Array<ServerTimingEntry>
}): Promise<string | null> {
	const destRepo = await resolveExistingArtifactSourceRepo(
		input.env,
		input.source.repo_id,
	)
	const info = destRepo ? await destRepo.info() : null
	if (info?.remote && isLoopbackArtifactsRemote(info.remote)) {
		return await pushServerTiming(
			input.serverTiming,
			'fork-loopback-snapshot',
			async () => {
				const snapshot = await writeArtifactSourceSnapshot({
					env: input.env,
					repoId: input.source.repo_id,
					files: input.files,
				})
				await writePublishedSourceSnapshot({
					env: input.env,
					source: {
						...input.source,
						published_commit: snapshot.published_commit,
					},
					files: input.files,
				})
				await updateEntitySource(input.env.APP_DB, {
					id: input.source.id,
					userId: input.source.user_id,
					publishedCommit: snapshot.published_commit,
				})
				return snapshot.published_commit
			},
		)
	}

	await updateEntitySource(input.env.APP_DB, {
		id: input.source.id,
		userId: input.source.user_id,
		publishedCommit: input.originCommit,
	})
	return await syncArtifactSourceSnapshot({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.source.id,
		files: input.changedFiles,
		bootstrapAccess: input.bootstrapAccess ?? null,
		serverTiming: input.serverTiming,
	})
}

export function shouldFallbackFromArtifactFork(error: unknown) {
	return isArtifactRepoNotFoundError(error)
}
