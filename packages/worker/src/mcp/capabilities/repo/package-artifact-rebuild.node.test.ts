import { expect, test, vi } from 'vitest'
import { publishedPackageArtifactRebuildConcurrency } from './package-artifact-rebuild.ts'

const mockModule = vi.hoisted(() => ({
	listPublishedPackageArtifactTargets: vi.fn(),
	stagePublishedPackageArtifactRebuild: vi.fn(),
	rebuildPublishedPackageArtifact: vi.fn(),
	createIsolatedArtifactRebuildRunner: vi.fn(),
	isPublishedPackageArtifactBuiltForCommit: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: () => ({
		listPublishedPackageArtifactTargets: (...args: Array<unknown>) =>
			mockModule.listPublishedPackageArtifactTargets(...args),
		stagePublishedPackageArtifactRebuild: (...args: Array<unknown>) =>
			mockModule.stagePublishedPackageArtifactRebuild(...args),
		rebuildPublishedPackageArtifact: (...args: Array<unknown>) =>
			mockModule.rebuildPublishedPackageArtifact(...args),
	}),
}))

vi.mock('#worker/repo/isolated-artifact-rebuild.ts', () => ({
	createIsolatedArtifactRebuildRunner: (...args: Array<unknown>) =>
		mockModule.createIsolatedArtifactRebuildRunner(...args),
}))

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', () => ({
	isPublishedPackageArtifactBuiltForCommit: (...args: Array<unknown>) =>
		mockModule.isPublishedPackageArtifactBuiltForCommit(...args),
}))

const { rebuildPublishedPackageArtifactsViaRepoSession } =
	await import('./package-artifact-rebuild.ts')

const sampleTargets = [
	{
		kind: 'module' as const,
		artifactName: '.',
		entryPoint: 'src/a.ts',
		bundleKind: 'module' as const,
	},
	{
		kind: 'module' as const,
		artifactName: './b',
		entryPoint: 'src/b.ts',
		bundleKind: 'module' as const,
	},
	{
		kind: 'module' as const,
		artifactName: './c',
		entryPoint: 'src/c.ts',
		bundleKind: 'module' as const,
	},
]

function resetMocks() {
	mockModule.listPublishedPackageArtifactTargets.mockReset()
	mockModule.stagePublishedPackageArtifactRebuild.mockReset()
	mockModule.rebuildPublishedPackageArtifact.mockReset()
	mockModule.createIsolatedArtifactRebuildRunner.mockReset()
	mockModule.isPublishedPackageArtifactBuiltForCommit.mockReset()
	mockModule.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(false)
}

test('isolated rebuild lists then stages once, fans out with bounded concurrency, and discards staging', async () => {
	expect(publishedPackageArtifactRebuildConcurrency).toBe(2)
	resetMocks()

	const run = vi.fn(async () => ({
		ok: true,
		message: 'rebuilt',
	}))
	const touch = vi.fn(async () => undefined)
	const discard = vi.fn(async () => undefined)
	mockModule.createIsolatedArtifactRebuildRunner.mockReturnValue({
		touch,
		run,
		discard,
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(
		sampleTargets,
	)
	mockModule.stagePublishedPackageArtifactRebuild.mockResolvedValue({
		stagingKey: 'repo-artifact-rebuild-staging:v1:user-1:stage-1',
	})

	let inFlight = 0
	let maxInFlight = 0
	const releaseGates: Array<() => void> = []
	run.mockImplementation(async () => {
		inFlight += 1
		maxInFlight = Math.max(maxInFlight, inFlight)
		await new Promise<void>((resolve) => {
			releaseGates.push(() => {
				inFlight -= 1
				resolve()
			})
		})
		return { ok: true, message: 'rebuilt' }
	})

	const rebuildPromise = rebuildPublishedPackageArtifactsViaRepoSession({
		env: {
			REPO_SESSION: {},
			BUNDLE_ARTIFACTS_KV: {},
		} as unknown as Env,
		rpcSessionId: 'session-1',
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-1',
		baseUrl: 'https://kody.test',
	})

	await vi.waitFor(() => {
		expect(run).toHaveBeenCalledTimes(2)
	})
	expect(maxInFlight).toBe(2)
	expect(mockModule.listPublishedPackageArtifactTargets).toHaveBeenCalledTimes(
		1,
	)
	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledTimes(
		1,
	)
	expect(mockModule.rebuildPublishedPackageArtifact).not.toHaveBeenCalled()
	expect(touch).not.toHaveBeenCalled()

	releaseGates.splice(0).forEach((release) => release())
	await vi.waitFor(() => {
		expect(run).toHaveBeenCalledTimes(3)
	})
	expect(touch).toHaveBeenCalledWith(
		'repo-artifact-rebuild-staging:v1:user-1:stage-1',
	)
	releaseGates.splice(0).forEach((release) => release())
	await rebuildPromise

	expect(maxInFlight).toBe(2)
	expect(run).toHaveBeenCalledTimes(3)
	expect(touch).toHaveBeenCalledTimes(1)
	expect(discard).toHaveBeenCalledWith(
		'repo-artifact-rebuild-staging:v1:user-1:stage-1',
	)
	expect(run).toHaveBeenCalledWith(
		expect.objectContaining({
			stagingKey: 'repo-artifact-rebuild-staging:v1:user-1:stage-1',
			sourceId: 'source-1',
			userId: 'user-1',
			publishedCommit: 'commit-1',
			target: sampleTargets[0],
		}),
	)
})

test('isolated rebuild skips already-built targets and does not stage when all are built', async () => {
	resetMocks()
	const run = vi.fn(async () => ({ ok: true, message: 'rebuilt' }))
	const discard = vi.fn(async () => undefined)
	mockModule.createIsolatedArtifactRebuildRunner.mockReturnValue({
		touch: vi.fn(),
		run,
		discard,
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(
		sampleTargets,
	)
	mockModule.stagePublishedPackageArtifactRebuild.mockResolvedValue({
		stagingKey: 'repo-artifact-rebuild-staging:v1:user-1:stage-1',
	})
	mockModule.isPublishedPackageArtifactBuiltForCommit.mockImplementation(
		async (input: { target: (typeof sampleTargets)[number] }) =>
			input.target.artifactName === '.' || input.target.artifactName === './c',
	)

	const rebuildInput = {
		env: {
			REPO_SESSION: {},
			BUNDLE_ARTIFACTS_KV: {},
		} as unknown as Env,
		rpcSessionId: 'session-1',
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-1',
		baseUrl: 'https://kody.test',
	}
	await rebuildPublishedPackageArtifactsViaRepoSession(rebuildInput)

	expect(run).toHaveBeenCalledTimes(1)
	expect(run).toHaveBeenCalledWith(
		expect.objectContaining({ target: sampleTargets[1] }),
	)
	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledTimes(
		1,
	)
	expect(discard).toHaveBeenCalledTimes(1)

	resetMocks()
	run.mockClear()
	discard.mockClear()
	mockModule.createIsolatedArtifactRebuildRunner.mockReturnValue({
		touch: vi.fn(),
		run,
		discard,
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(
		sampleTargets,
	)
	mockModule.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(true)

	await rebuildPublishedPackageArtifactsViaRepoSession(rebuildInput)

	expect(mockModule.listPublishedPackageArtifactTargets).toHaveBeenCalledTimes(
		1,
	)
	expect(mockModule.stagePublishedPackageArtifactRebuild).not.toHaveBeenCalled()
	expect(run).not.toHaveBeenCalled()
	expect(discard).not.toHaveBeenCalled()
})

test('rebuild failure stops later chunks and reports succeeded versus failed for isolated and fallback paths', async () => {
	const targets = [
		...sampleTargets,
		{
			kind: 'module' as const,
			artifactName: './d',
			entryPoint: 'src/d.ts',
			bundleKind: 'module' as const,
		},
	]
	const failurePattern =
		/Succeeded: \{ kind "module", artifact "\.", entry "src\/a\.ts", bundle "module" \}\. Failed: \{ kind "module", artifact "\.\/b", entry "src\/b\.ts", bundle "module" \}: bundle b failed/

	resetMocks()
	const run = vi.fn(async (input: { target: (typeof targets)[number] }) => {
		if (input.target.artifactName === './b') {
			return { ok: false, message: 'bundle b failed' }
		}
		return { ok: true, message: 'rebuilt' }
	})
	const touch = vi.fn(async () => undefined)
	const discard = vi.fn(async () => undefined)
	mockModule.createIsolatedArtifactRebuildRunner.mockReturnValue({
		touch,
		run,
		discard,
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(targets)
	mockModule.stagePublishedPackageArtifactRebuild.mockResolvedValue({
		stagingKey: 'repo-artifact-rebuild-staging:v1:user-1:stage-1',
	})

	await expect(
		rebuildPublishedPackageArtifactsViaRepoSession({
			env: {
				REPO_SESSION: {},
				BUNDLE_ARTIFACTS_KV: {},
			} as unknown as Env,
			rpcSessionId: 'session-1',
			sourceId: 'source-1',
			userId: 'user-1',
			publishedCommit: 'commit-1',
			baseUrl: 'https://kody.test',
		}),
	).rejects.toThrow(failurePattern)
	expect(touch).not.toHaveBeenCalled()
	expect(run).toHaveBeenCalledTimes(2)
	expect(run).not.toHaveBeenCalledWith(
		expect.objectContaining({ target: targets[2] }),
	)
	expect(run).not.toHaveBeenCalledWith(
		expect.objectContaining({ target: targets[3] }),
	)
	expect(discard).toHaveBeenCalledWith(
		'repo-artifact-rebuild-staging:v1:user-1:stage-1',
	)

	resetMocks()
	mockModule.createIsolatedArtifactRebuildRunner.mockReturnValue(null)
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(targets)
	mockModule.rebuildPublishedPackageArtifact.mockImplementation(
		async (input: { target: (typeof targets)[number] }) => {
			if (input.target.artifactName === './b') {
				throw new Error('bundle b failed')
			}
			return { ok: true, target: input.target, kvKey: 'bundle-key' }
		},
	)

	await expect(
		rebuildPublishedPackageArtifactsViaRepoSession({
			env: {} as Env,
			rpcSessionId: 'session-1',
			sourceId: 'source-1',
			userId: 'user-1',
			publishedCommit: 'commit-1',
			baseUrl: 'https://kody.test',
		}),
	).rejects.toThrow(failurePattern)

	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(2)
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledWith(
		expect.objectContaining({ target: targets[0] }),
	)
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledWith(
		expect.objectContaining({ target: targets[1] }),
	)
	expect(mockModule.rebuildPublishedPackageArtifact).not.toHaveBeenCalledWith(
		expect.objectContaining({ target: targets[2] }),
	)
	expect(mockModule.rebuildPublishedPackageArtifact).not.toHaveBeenCalledWith(
		expect.objectContaining({ target: targets[3] }),
	)
})

test('falls back to per-target session rebuild when isolated runner bindings are missing', async () => {
	resetMocks()
	mockModule.createIsolatedArtifactRebuildRunner.mockReturnValue(null)
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(
		sampleTargets,
	)

	let inFlight = 0
	let maxInFlight = 0
	const releaseGates: Array<() => void> = []
	mockModule.rebuildPublishedPackageArtifact.mockImplementation(async () => {
		inFlight += 1
		maxInFlight = Math.max(maxInFlight, inFlight)
		await new Promise<void>((resolve) => {
			releaseGates.push(() => {
				inFlight -= 1
				resolve()
			})
		})
		return { ok: true }
	})

	const rebuildPromise = rebuildPublishedPackageArtifactsViaRepoSession({
		env: {} as Env,
		rpcSessionId: 'session-1',
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-1',
		baseUrl: 'https://kody.test',
	})

	await vi.waitFor(() => {
		expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(2)
	})
	expect(maxInFlight).toBe(2)
	expect(mockModule.stagePublishedPackageArtifactRebuild).not.toHaveBeenCalled()

	releaseGates.splice(0).forEach((release) => release())
	await vi.waitFor(() => {
		expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(3)
	})
	releaseGates.splice(0).forEach((release) => release())
	await rebuildPromise

	expect(maxInFlight).toBe(2)
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(3)
})
