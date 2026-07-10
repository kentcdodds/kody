import git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	isLoopbackArtifactsRemote,
	readMockArtifactSnapshot,
	resolveExistingArtifactSourceRepo,
} from './artifacts.ts'
import { createEphemeralGitWorkspace } from './ephemeral-git-workspace.ts'

export async function readArtifactFileAtCommit(input: {
	env: Env
	repoId: string
	commit: string
	filePath: string
}): Promise<Uint8Array | null> {
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
		const content = snapshot?.files[input.filePath]
		return content == null ? null : new TextEncoder().encode(content)
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
	await git.fetch({
		fs: workspace.fs,
		http,
		dir: workspace.dir,
		url: remote,
		ref: input.commit,
		depth: 1,
		singleBranch: true,
		tags: false,
		onAuth() {
			return auth
		},
	})

	try {
		const result = await git.readBlob({
			fs: workspace.fs,
			dir: workspace.dir,
			oid: input.commit,
			filepath: input.filePath,
		})
		return result.blob
	} catch (error) {
		if (isMissingArtifactFileError(error)) return null
		throw error
	}
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
