import { expect, test, vi } from 'vitest'
import {
	createIsolatedArtifactRebuildRunner,
	isolatedArtifactRebuildStagingKeyBelongsToUser,
	isolatedArtifactRebuildStagingKeyForUser,
	isolatedArtifactRebuildStagingKeyPrefix,
} from './isolated-artifact-rebuild.ts'

test('staging keys are user-namespaced and ownership-checked', () => {
	const key = isolatedArtifactRebuildStagingKeyForUser('user-1')
	expect(
		key.startsWith(`${isolatedArtifactRebuildStagingKeyPrefix}user-1:`),
	).toBe(true)
	expect(
		isolatedArtifactRebuildStagingKeyBelongsToUser({
			stagingKey: key,
			userId: 'user-1',
		}),
	).toBe(true)
	expect(
		isolatedArtifactRebuildStagingKeyBelongsToUser({
			stagingKey: key,
			userId: 'user-2',
		}),
	).toBe(false)
	expect(
		isolatedArtifactRebuildStagingKeyBelongsToUser({
			stagingKey: 'repo-checks-staging:v1:user-1:abc',
			userId: 'user-1',
		}),
	).toBe(false)
})

test('createIsolatedArtifactRebuildRunner returns null without bindings', () => {
	expect(createIsolatedArtifactRebuildRunner(undefined)).toBeNull()
	expect(createIsolatedArtifactRebuildRunner({} as Env)).toBeNull()
	expect(
		createIsolatedArtifactRebuildRunner({
			REPO_SESSION: {},
		} as unknown as Env),
	).toBeNull()
	expect(
		createIsolatedArtifactRebuildRunner({
			BUNDLE_ARTIFACTS_KV: {},
		} as unknown as Env),
	).toBeNull()
})

test('runner touches staging TTL, fans out one target per throwaway DO, and maps reset errors', async () => {
	const put = vi.fn(async () => undefined)
	const get = vi.fn(async () =>
		JSON.stringify({ sourceFiles: { 'package.json': '{}' } }),
	)
	const del = vi.fn(async () => undefined)
	const runIsolatedArtifactRebuild = vi.fn(async () => ({
		ok: true,
		message: 'rebuilt',
	}))
	const idFromName = vi.fn((name: string) => ({ name }))
	const getStub = vi.fn(() => ({ runIsolatedArtifactRebuild }))
	const runner = createIsolatedArtifactRebuildRunner({
		REPO_SESSION: { idFromName, get: getStub },
		BUNDLE_ARTIFACTS_KV: { put, get, delete: del },
	} as unknown as Env)
	expect(runner).not.toBeNull()
	if (!runner) throw new Error('expected runner')

	const stagingKey = `${isolatedArtifactRebuildStagingKeyPrefix}user-1:stage-1`
	await runner.touch(stagingKey)
	expect(get).toHaveBeenCalledWith(stagingKey, 'text')
	expect(put).toHaveBeenCalledWith(
		stagingKey,
		JSON.stringify({ sourceFiles: { 'package.json': '{}' } }),
		{ expirationTtl: 15 * 60 },
	)

	const target = {
		kind: 'module' as const,
		artifactName: '.',
		entryPoint: 'src/index.ts',
		bundleKind: 'module' as const,
	}
	const outcome = await runner.run({
		stagingKey,
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-1',
		target,
		baseUrl: 'https://kody.test',
	})
	expect(outcome.ok).toBe(true)
	expect(idFromName).toHaveBeenCalledWith(
		expect.stringMatching(/^isolated-artifact-rebuild-user-1-/),
	)
	expect(runIsolatedArtifactRebuild).toHaveBeenCalledWith({
		stagingKey,
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-1',
		target,
		baseUrl: 'https://kody.test',
	})

	runIsolatedArtifactRebuild.mockRejectedValueOnce(
		new Error(
			"Durable Object's isolate exceeded its memory limit and was reset.",
		),
	)
	const resetOutcome = await runner.run({
		stagingKey,
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-1',
		target,
	})
	expect(resetOutcome.ok).toBe(false)
	expect(resetOutcome.message).toContain('memory or CPU limits')
	expect(resetOutcome.target).toEqual(target)

	// Deploy resets must not be remapped to "package too large" — callers retry.
	runIsolatedArtifactRebuild.mockRejectedValueOnce(
		new Error('Durable Object reset because its code was updated.'),
	)
	await expect(
		runner.run({
			stagingKey,
			sourceId: 'source-1',
			userId: 'user-1',
			publishedCommit: 'commit-1',
			target,
		}),
	).rejects.toThrow('Durable Object reset because its code was updated.')

	await runner.discard(stagingKey)
	expect(del).toHaveBeenCalledWith(stagingKey)
})
