import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	measureRepoSessionWorkspaceBlobBytes,
	purgeRepoSessionWorkspaceBlobs,
	repoSessionWorkspaceR2ListPrefix,
} from './repo-session-blobs.ts'

test('REPO_SESSION_BLOBS prefix purge removes only that Durable Object workspace', async () => {
	const durableObjectId = `workers-test-${crypto.randomUUID()}`
	const otherDurableObjectId = `workers-test-${crypto.randomUUID()}`
	const prefix = repoSessionWorkspaceR2ListPrefix(durableObjectId)
	const otherPrefix = repoSessionWorkspaceR2ListPrefix(otherDurableObjectId)
	const keepKey = `${otherPrefix}default/session/keep.bin`
	await env.REPO_SESSION_BLOBS.put(`${prefix}default/session/a.pack`, 'aaaa')
	await env.REPO_SESSION_BLOBS.put(`${prefix}default/session/b.pack`, 'bbbbbb')
	await env.REPO_SESSION_BLOBS.put(keepKey, 'keep-me')

	await expect(
		measureRepoSessionWorkspaceBlobBytes({
			blobs: env.REPO_SESSION_BLOBS,
			durableObjectId,
		}),
	).resolves.toBe(10)

	await purgeRepoSessionWorkspaceBlobs({
		blobs: env.REPO_SESSION_BLOBS,
		durableObjectId,
	})

	expect(
		await env.REPO_SESSION_BLOBS.get(`${prefix}default/session/a.pack`),
	).toBeNull()
	expect(
		await env.REPO_SESSION_BLOBS.get(`${prefix}default/session/b.pack`),
	).toBeNull()
	expect(await env.REPO_SESSION_BLOBS.get(keepKey)).not.toBeNull()
	await env.REPO_SESSION_BLOBS.delete(keepKey)
})
