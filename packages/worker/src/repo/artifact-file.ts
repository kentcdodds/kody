import git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	isLoopbackArtifactsRemote,
	readMockArtifactSnapshot,
	resolveExistingArtifactSourceRepo,
} from './artifacts.ts'
import {
	runArtifactsGitWithRetry,
	wrapArtifactsGitHttpError,
} from './artifacts-git-retry.ts'
import { createEphemeralGitWorkspace } from './ephemeral-git-workspace.ts'

export async function readArtifactFileAtCommit(input: {
	env: Env
	repoId: string
	commit: string
	filePath: string
}): Promise<Uint8Array | null> {
	const found = await readFirstArtifactFileAtCommit({
		env: input.env,
		repoId: input.repoId,
		commit: input.commit,
		filePaths: [input.filePath],
	})
	return found?.bytes ?? null
}

/**
 * Reads the first candidate path that exists at the given commit using a
 * single shallow fetch, so callers probing a small set of well-known paths
 * (for example `community-icon.*`) do not pay one fetch per candidate.
 */
export async function readFirstArtifactFileAtCommit(input: {
	env: Env
	repoId: string
	commit: string
	filePaths: ReadonlyArray<string>
}): Promise<{ path: string; bytes: Uint8Array } | null> {
	const repo = await resolveExistingArtifactSourceRepo(input.env, input.repoId)
	if (!repo) {
		throw new Error(`Artifact repo "${input.repoId}" was not found.`)
	}
	const info = await repo.info()
	if (!info?.remote) {
		throw new Error('Artifact repo remote URL is unavailable.')
	}

	if (isLoopbackArtifactsRemote(info.remote)) {
		const snapshot = await readMockArtifactSnapshot({
			env: input.env,
			repoId: input.repoId,
			commit: input.commit,
		})
		for (const filePath of input.filePaths) {
			const content = snapshot?.files[filePath]
			if (content != null) {
				return { path: filePath, bytes: new TextEncoder().encode(content) }
			}
		}
		return null
	}

	const token = await repo.createToken('read', 300)
	const remote = buildAuthenticatedArtifactsRemote({
		remote: info.remote,
		token: token.plaintext,
	})
	const auth = buildArtifactsGitAuth({ token: token.plaintext })
	const workspace = createEphemeralGitWorkspace()
	await git.init({
		fs: workspace.fs,
		dir: workspace.dir,
	})
	await git.addRemote({
		fs: workspace.fs,
		dir: workspace.dir,
		remote: 'origin',
		url: remote,
	})
	try {
		await runArtifactsGitWithRetry(() =>
			git.fetch({
				fs: workspace.fs,
				http,
				dir: workspace.dir,
				remote: 'origin',
				ref: input.commit,
				depth: 1,
				singleBranch: true,
				tags: false,
				onAuth() {
					return auth
				},
			}),
		)
	} catch (error) {
		throw wrapArtifactsGitHttpError({
			operation: 'git fetch',
			remote: info.remote,
			error,
		})
	}

	for (const filePath of input.filePaths) {
		try {
			const result = await git.readBlob({
				fs: workspace.fs,
				dir: workspace.dir,
				oid: input.commit,
				filepath: filePath,
			})
			return { path: filePath, bytes: result.blob }
		} catch (error) {
			if (!isMissingArtifactFileError(error)) throw error
		}
	}
	return null
}

function isMissingArtifactFileError(error: unknown) {
	if (
		error instanceof Error &&
		'code' in error &&
		typeof error.code === 'string' &&
		['NotFoundError', 'ResolveTreeError'].includes(error.code)
	) {
		return true
	}
	return (
		error instanceof Error &&
		/(could not find|not found|no such file|resolve.*tree)/i.test(error.message)
	)
}
