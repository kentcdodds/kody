/**
 * R2 spill for RepoSession `@cloudflare/shell` Workspace objects.
 *
 * Workspace keys are `{name}/{namespace}{path}`. The workspace `name` is
 * `repo-session:{durableObjectId}`, so every object for one session DO lives
 * under `repo-session:{durableObjectId}/`. `Workspace.rm` deletes listed R2
 * keys while SQL metadata still exists; `deleteAll()` drops that metadata, so
 * prefix purge is the safety net after storage wipe and for account deletion.
 *
 * This bucket is ephemeral session scratch. It is not a DR canonical store
 * and is not a user-visible rewrite of repo files (decision 0003).
 */

const repoSessionWorkspaceNamePrefix = 'repo-session'
const r2ListPageSize = 1000

export function buildRepoSessionWorkspaceName(durableObjectId: string) {
	return `${repoSessionWorkspaceNamePrefix}:${durableObjectId}`
}

export function repoSessionWorkspaceR2ListPrefix(durableObjectId: string) {
	return `${buildRepoSessionWorkspaceName(durableObjectId)}/`
}

function isR2Bucket(value: R2Bucket | null | undefined): value is R2Bucket {
	return (
		value != null &&
		typeof value.list === 'function' &&
		typeof value.delete === 'function'
	)
}

export async function purgeRepoSessionWorkspaceBlobs(input: {
	blobs?: R2Bucket | null
	durableObjectId: string
}): Promise<void> {
	if (!isR2Bucket(input.blobs)) return
	const prefix = repoSessionWorkspaceR2ListPrefix(input.durableObjectId)
	for (;;) {
		const page = await input.blobs.list({
			prefix,
			limit: r2ListPageSize,
		})
		if (page.objects.length === 0) return
		await input.blobs.delete(page.objects.map((object) => object.key))
	}
}

export async function measureRepoSessionWorkspaceBlobBytes(input: {
	blobs?: R2Bucket | null
	durableObjectId: string
}): Promise<number> {
	if (!isR2Bucket(input.blobs)) return 0
	const prefix = repoSessionWorkspaceR2ListPrefix(input.durableObjectId)
	let total = 0
	let cursor: string | undefined
	for (;;) {
		const page = await input.blobs.list({
			prefix,
			limit: r2ListPageSize,
			...(cursor ? { cursor } : {}),
		})
		for (const object of page.objects) {
			total += object.size
		}
		if (!page.truncated) return total
		cursor = page.cursor
	}
}
