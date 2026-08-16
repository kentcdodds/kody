import { expect, test, vi } from 'vitest'
import {
	buildRepoSessionWorkspaceName,
	measureRepoSessionWorkspaceBlobBytes,
	purgeRepoSessionWorkspaceBlobs,
	repoSessionWorkspaceR2ListPrefix,
} from './repo-session-blobs.ts'

function createFakeR2(initial: Record<string, number>) {
	const objects = new Map(
		Object.entries(initial).map(([key, size]) => [key, size]),
	)
	const list = vi.fn(async (options: { prefix: string; cursor?: string }) => {
		const keys = [...objects.keys()]
			.filter((key) => key.startsWith(options.prefix))
			.sort()
		const pageSize = 2
		const start = options.cursor ? Number(options.cursor) : 0
		const pageKeys = keys.slice(start, start + pageSize)
		const next = start + pageSize
		return {
			objects: pageKeys.map((key) => ({ key, size: objects.get(key) ?? 0 })),
			truncated: next < keys.length,
			cursor: next < keys.length ? String(next) : undefined,
		}
	})
	const del = vi.fn(async (keys: string | Array<string>) => {
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			objects.delete(key)
		}
	})
	return {
		objects,
		bucket: { list, delete: del } as unknown as R2Bucket,
	}
}

test('repo session workspace R2 prefix is the workspace name plus a slash', () => {
	expect(buildRepoSessionWorkspaceName('do-session-1')).toBe(
		'repo-session:do-session-1',
	)
	expect(repoSessionWorkspaceR2ListPrefix('do-session-1')).toBe(
		'repo-session:do-session-1/',
	)
})

test('purge and measure walk paged R2 listings for one Durable Object prefix', async () => {
	const keepKey = 'repo-session:other-do/default/session/pack.pack'
	const { objects, bucket } = createFakeR2({
		'repo-session:do-session-1/default/session/.git/objects/pack/a.pack': 1_000,
		'repo-session:do-session-1/default/session/.git/objects/pack/b.pack': 2_000,
		'repo-session:do-session-1/default/session/large.bin': 3_000,
		[keepKey]: 9_000,
	})

	await expect(
		measureRepoSessionWorkspaceBlobBytes({
			blobs: bucket,
			durableObjectId: 'do-session-1',
		}),
	).resolves.toBe(6_000)

	await purgeRepoSessionWorkspaceBlobs({
		blobs: bucket,
		durableObjectId: 'do-session-1',
	})

	expect([...objects.keys()]).toEqual([keepKey])
	await expect(
		measureRepoSessionWorkspaceBlobBytes({
			blobs: bucket,
			durableObjectId: 'do-session-1',
		}),
	).resolves.toBe(0)
})

test('purge and measure no-op when the R2 binding is missing', async () => {
	await expect(
		purgeRepoSessionWorkspaceBlobs({
			blobs: null,
			durableObjectId: 'do-session-1',
		}),
	).resolves.toBeUndefined()
	await expect(
		measureRepoSessionWorkspaceBlobBytes({
			durableObjectId: 'do-session-1',
		}),
	).resolves.toBe(0)
	await expect(
		purgeRepoSessionWorkspaceBlobs({
			blobs: {} as R2Bucket,
			durableObjectId: 'do-session-1',
		}),
	).resolves.toBeUndefined()
})
