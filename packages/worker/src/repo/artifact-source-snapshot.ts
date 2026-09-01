import { createCloudflareRestClient } from '#mcp/cloudflare/cloudflare-rest-client.ts'
import {
	getArtifactsNamespace,
	requestArtifactsApi,
	requestArtifactsEnvelope,
} from './artifacts.ts'

/**
 * Whole-tree snapshot of an Artifacts repo at one commit.
 *
 * Cloudflare's API has no endpoint for this: production reads published trees
 * from the KV snapshots written at publish time and never calls here for real
 * data. A local Cloudflare API stand-in can serve trees for repos that have no
 * git remote, and `CLOUDFLARE_API_SOURCE_SNAPSHOTS=true` (set by the dev CLI
 * next to `CLOUDFLARE_API_BASE_URL`) opts a runtime into asking it. With the
 * flag unset, reads return `null` without a request, so a KV miss in production
 * costs nothing extra.
 */
export type ArtifactSourceSnapshot = {
	published_commit: string
	files: Record<string, string>
}

export function hasArtifactSourceSnapshotApi(env: Env) {
	return env.CLOUDFLARE_API_SOURCE_SNAPSHOTS?.trim() === 'true'
}

function buildSnapshotPath(env: Env, repoId: string) {
	return `/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/artifacts/namespaces/${getArtifactsNamespace(env)}/repos/${encodeURIComponent(repoId)}/mock-source-snapshot`
}

export async function readArtifactSourceSnapshot(input: {
	env: Env
	repoId: string
	commit: string | null
}): Promise<ArtifactSourceSnapshot | null> {
	if (!hasArtifactSourceSnapshotApi(input.env)) return null
	const client = createCloudflareRestClient(input.env)
	const envelope = await requestArtifactsEnvelope<ArtifactSourceSnapshot>(
		client,
		{
			method: 'GET',
			path: buildSnapshotPath(input.env, input.repoId),
			query: input.commit ? { commit: input.commit } : undefined,
			treat404AsNull: true,
		},
	)
	return envelope.result
}

export async function writeArtifactSourceSnapshot(input: {
	env: Env
	repoId: string
	files: Record<string, string>
}) {
	if (!hasArtifactSourceSnapshotApi(input.env)) {
		throw new Error(
			'Source snapshot writes need CLOUDFLARE_API_SOURCE_SNAPSHOTS=true and an API that serves them.',
		)
	}
	const client = createCloudflareRestClient(input.env)
	return await requestArtifactsApi<ArtifactSourceSnapshot>(client, {
		method: 'POST',
		path: buildSnapshotPath(input.env, input.repoId),
		body: { files: input.files },
	})
}
