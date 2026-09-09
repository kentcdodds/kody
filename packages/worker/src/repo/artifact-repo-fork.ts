import { rewritePackageManifestForFork } from '#worker/community/fork-scan.ts'
import { writePublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { readArtifactFileAtCommit } from './artifact-file.ts'
import { writeArtifactSourceSnapshot } from './artifact-source-snapshot.ts'
import {
	getArtifactsBinding,
	isArtifactRepoNotFoundError,
	isLoopbackArtifactsRemote,
	resolveArtifactSourceHead,
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

export type PersistForkedArtifactRepoResult = {
	copiedOriginCommit: string
	destCommit: string | null
}

/**
 * After a storage-layer Artifacts fork, stamp dest HEAD and rewrite only
 * what is safe against that tip.
 *
 * Loopback remotes (local mock) have no real git object store: the copied
 * mock snapshot is overwritten with the already-rewritten Worker tree so
 * dest contents match production's "fork + small commit" outcome without
 * opening a RepoSession.
 *
 * Production remotes apply the rewrite as a first publish from dest HEAD
 * (the default-branch tip Artifacts copied). They must not stamp
 * `published_commit` before that rewrite: doing so opens the existing-source
 * session path and `publishSession({ force: true })`, which the overwrite
 * gate correctly rejects for a brand-new fork. When dest HEAD matches the
 * listing pin used in prepare, `changedFiles` apply. When dest HEAD is
 * ahead of that pin, only dest HEAD's `package.json` is rewritten so
 * pin-relative edits cannot revert later origin commits.
 */
export async function persistForkedArtifactRepoContents(input: {
	env: Env
	baseUrl: string
	userId: string
	source: EntitySourceRow
	originCommit: string
	expectedPackageScope: string
	targetKodyId: string
	changedFiles: Record<string, string>
	files: Record<string, string>
	bootstrapAccess?: ArtifactBootstrapAccess | null
	serverTiming?: Array<ServerTimingEntry>
}): Promise<PersistForkedArtifactRepoResult> {
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
				const marked = await updateEntitySource(input.env.APP_DB, {
					id: input.source.id,
					userId: input.source.user_id,
					publishedCommit: snapshot.published_commit,
				})
				if (!marked) {
					throw new Error(
						`Forked source "${input.source.id}" could not be marked at dest commit ${snapshot.published_commit}.`,
					)
				}
				return {
					copiedOriginCommit: input.originCommit,
					destCommit: snapshot.published_commit,
				}
			},
		)
	}

	const destHead = await resolveArtifactSourceHead(
		input.env,
		input.source.repo_id,
	)
	if (!destHead.commit) {
		throw new Error(
			`Forked artifact repo "${input.source.repo_id}" default branch has no HEAD.`,
		)
	}

	const filesToSync =
		destHead.commit === input.originCommit
			? input.changedFiles
			: await buildDestHeadRewriteFiles({
					env: input.env,
					repoId: input.source.repo_id,
					destHead: destHead.commit,
					expectedPackageScope: input.expectedPackageScope,
					targetKodyId: input.targetKodyId,
				})
	if (Object.keys(filesToSync).length === 0) {
		const marked = await updateEntitySource(input.env.APP_DB, {
			id: input.source.id,
			userId: input.source.user_id,
			publishedCommit: destHead.commit,
		})
		if (!marked) {
			throw new Error(
				`Forked source "${input.source.id}" could not be marked at dest HEAD ${destHead.commit}.`,
			)
		}
		return {
			copiedOriginCommit: destHead.commit,
			destCommit: destHead.commit,
		}
	}
	const destCommit = await syncArtifactSourceSnapshot({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.source.id,
		files: filesToSync,
		existingHeadCommit: destHead.commit,
		bootstrapAccess: input.bootstrapAccess ?? null,
		serverTiming: input.serverTiming,
	})
	return {
		copiedOriginCommit: destHead.commit,
		destCommit,
	}
}

async function buildDestHeadRewriteFiles(input: {
	env: Env
	repoId: string
	destHead: string
	expectedPackageScope: string
	targetKodyId: string
}): Promise<Record<string, string>> {
	const bytes = await readArtifactFileAtCommit({
		env: input.env,
		repoId: input.repoId,
		commit: input.destHead,
		filePath: 'package.json',
	})
	if (!bytes) {
		throw new Error(
			`Forked artifact repo "${input.repoId}" is missing package.json at ${input.destHead}.`,
		)
	}
	const manifestContent = new TextDecoder().decode(bytes)
	const rewritten = rewritePackageManifestForFork({
		manifestContent,
		expectedPackageScope: input.expectedPackageScope,
		targetKodyId: input.targetKodyId,
	})
	if (rewritten.content === manifestContent) return {}
	return { 'package.json': rewritten.content }
}

export function shouldFallbackFromArtifactFork(error: unknown) {
	return isArtifactRepoNotFoundError(error)
}
