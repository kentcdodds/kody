import { CloudflareApiError } from '#mcp/cloudflare/cloudflare-rest-client.ts'
import { resolveArtifactSourceRepo } from './artifacts.ts'

export async function revokeStaleArtifactsTokens(
	env: Env,
	repoName: string,
	input: {
		keepAfter: Date
	},
) {
	const repo = await resolveArtifactSourceRepo(env, repoName)
	if (!repo.listTokens || !repo.revokeToken) {
		return {
			checked: 0,
			revoked: 0,
		}
	}
	const tokens = await repo.listTokens()
	let revoked = 0
	for (const token of tokens) {
		if (new Date(token.expiresAt) >= input.keepAfter) {
			continue
		}
		try {
			await repo.revokeToken(token.id)
		} catch (error) {
			if (!(error instanceof CloudflareApiError && error.status === 404)) {
				throw error
			}
		}
		revoked += 1
	}
	return {
		checked: tokens.length,
		revoked,
	}
}
