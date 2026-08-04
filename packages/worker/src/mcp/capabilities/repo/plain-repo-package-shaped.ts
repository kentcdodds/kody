import { readArtifactFileAtCommit } from '#worker/repo/artifact-file.ts'
import { plainRepoPackageShapedNotice } from '#worker/repo/user-repos.ts'

export async function isPlainRepoPackageShapedAtCommit(input: {
	env: Env
	repoId: string
	commit: string | null
}) {
	if (!input.commit) return false
	const bytes = await readArtifactFileAtCommit({
		env: input.env,
		repoId: input.repoId,
		commit: input.commit,
		filePath: 'package.json',
	})
	return bytes != null
}

export function buildPlainRepoPackageShapedFields(input: {
	packageShaped: boolean
}) {
	if (!input.packageShaped) {
		return {
			package_shaped: false as const,
			activated: false as const,
			notice: null,
		}
	}
	return {
		package_shaped: true as const,
		activated: false as const,
		notice: plainRepoPackageShapedNotice,
	}
}
