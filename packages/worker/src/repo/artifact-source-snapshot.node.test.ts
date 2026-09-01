import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	rawRequest:
		vi.fn<
			() => Promise<{ status: number; body: unknown; cfRay: string | null }>
		>(),
}))

vi.mock('#mcp/cloudflare/cloudflare-rest-client.ts', () => ({
	CloudflareApiError: class CloudflareApiError extends Error {
		status = 500
	},
	createCloudflareRestClient: () => ({ rawRequest: mocks.rawRequest }),
}))

const {
	hasArtifactSourceSnapshotApi,
	readArtifactSourceSnapshot,
	writeArtifactSourceSnapshot,
} = await import('./artifact-source-snapshot.ts')

const baseEnv = {
	CLOUDFLARE_ACCOUNT_ID: 'acct',
	CLOUDFLARE_API_TOKEN: 'token',
	ARTIFACTS_NAMESPACE: 'default',
} as Env

test('reads return null and make no request unless the API opts in', async () => {
	mocks.rawRequest.mockReset()
	expect(hasArtifactSourceSnapshotApi(baseEnv)).toBe(false)
	await expect(
		readArtifactSourceSnapshot({
			env: baseEnv,
			repoId: 'repo-1',
			commit: 'commit-1',
		}),
	).resolves.toBeNull()
	expect(mocks.rawRequest).not.toHaveBeenCalled()
	await expect(
		writeArtifactSourceSnapshot({
			env: baseEnv,
			repoId: 'repo-1',
			files: {},
		}),
	).rejects.toThrow(/CLOUDFLARE_API_SOURCE_SNAPSHOTS/)
})

test('an opted-in API is asked for the tree at the commit', async () => {
	mocks.rawRequest.mockReset()
	mocks.rawRequest.mockResolvedValue({
		status: 200,
		cfRay: null,
		body: {
			success: true,
			result: { published_commit: 'commit-1', files: { 'a.ts': 'a' } },
			errors: [],
			messages: [],
		},
	})
	const env = { ...baseEnv, CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true' } as Env
	expect(hasArtifactSourceSnapshotApi(env)).toBe(true)

	await expect(
		readArtifactSourceSnapshot({ env, repoId: 'repo-1', commit: 'commit-1' }),
	).resolves.toEqual({ published_commit: 'commit-1', files: { 'a.ts': 'a' } })
	expect(mocks.rawRequest).toHaveBeenCalledWith(
		expect.objectContaining({
			method: 'GET',
			path: '/client/v4/accounts/acct/artifacts/namespaces/default/repos/repo-1/mock-source-snapshot',
			query: { commit: 'commit-1' },
		}),
	)
})
