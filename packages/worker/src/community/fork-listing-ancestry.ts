import {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	isLoopbackArtifactsRemote,
	resolveExistingArtifactSourceRepo,
} from '#worker/repo/artifacts.ts'
import { runArtifactsGitWithRetry } from '#worker/repo/artifacts-git-retry.ts'
import { createEphemeralGitWorkspace } from '#worker/repo/ephemeral-git-workspace.ts'
import { loadIsomorphicGit } from '#worker/repo/isomorphic-git-lazy.ts'

/**
 * Walk the listing origin repo from the fork's absorb marker (`origin_commit`).
 * Both SHAs live in that origin graph — the fork is a new Artifacts repo and
 * never contains the listing pin. Returns true when `ancestor` is the tip or
 * appears in its history, false when the walk completes without it, and null
 * when the graph cannot be read (missing repo, loopback snapshot, or fetch
 * failure).
 */
export async function listingPinIsAncestorOfForkTip(input: {
	env: Env
	repoId: string
	listingPinnedCommit: string
	forkTip: string
}): Promise<boolean | null> {
	const ancestor = input.listingPinnedCommit.trim()
	const descendant = input.forkTip.trim()
	if (ancestor.length === 0 || descendant.length === 0) return null
	if (ancestor === descendant) return true

	const repo = await resolveExistingArtifactSourceRepo(input.env, input.repoId)
	if (!repo) return null
	const info = await repo.info()
	if (!info?.remote) return null
	if (isLoopbackArtifactsRemote(info.remote)) return null

	const token = await repo.createToken('read', 300)
	const remote = buildAuthenticatedArtifactsRemote({
		remote: info.remote,
		token: token.plaintext,
	})
	const auth = buildArtifactsGitAuth({ token: token.plaintext })
	const { git, http } = await loadIsomorphicGit()
	try {
		return await runArtifactsGitWithRetry(async () => {
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
			await git.fetch({
				fs: workspace.fs,
				http,
				dir: workspace.dir,
				remote: 'origin',
				ref: descendant,
				depth: Number.POSITIVE_INFINITY,
				singleBranch: true,
				tags: false,
				onAuth() {
					return auth
				},
			})
			const commits = await git.log({
				fs: workspace.fs,
				dir: workspace.dir,
				ref: descendant,
				depth: Number.POSITIVE_INFINITY,
			})
			return commits.some((commit) => commit.oid === ancestor)
		})
	} catch {
		return null
	}
}
