import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	listPublishedPackageArtifactTargets: vi.fn(),
	stagePublishedPackageArtifactRebuild: vi.fn(),
	rebuildPublishedPackageArtifact: vi.fn(),
	createIsolatedArtifactRebuildRunner: vi.fn(),
	isPublishedPackageArtifactBuiltForCommit: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		listPublishedPackageArtifactTargets: (...args: Array<unknown>) =>
			mockModule.listPublishedPackageArtifactTargets(...args),
		stagePublishedPackageArtifactRebuild: (...args: Array<unknown>) =>
			mockModule.stagePublishedPackageArtifactRebuild(...args),
		rebuildPublishedPackageArtifact: (...args: Array<unknown>) =>
			mockModule.rebuildPublishedPackageArtifact(...args),
	}),
}))

vi.mock('#worker/repo/isolated-artifact-rebuild.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#worker/repo/isolated-artifact-rebuild.ts')
	>('#worker/repo/isolated-artifact-rebuild.ts')
	return {
		...actual,
		createIsolatedArtifactRebuildRunner: (...args: Array<unknown>) =>
			mockModule.createIsolatedArtifactRebuildRunner(...args),
	}
})

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
	{
		kind: 'module' as const,
		artifactName: './d',
		entryPoint: 'src/d.ts',
		bundleKind: 'module' as const,
	},
	{
		kind: 'module' as const,
		artifactName: './e',
		entryPoint: 'src/e.ts',
		bundleKind: 'module' as const,
	},
	{
		kind: 'module' as const,
		artifactName: './f',
		entryPoint: 'src/f.ts',
		bundleKind: 'module' as const,
	},
	{
		kind: 'module' as const,
		artifactName: './g',
		entryPoint: 'src/g.ts',
		bundleKind: 'module' as const,
	},
	{
		kind: 'module' as const,
		artifactName: './h',
		entryPoint: 'src/h.ts',
		bundleKind: 'module' as const,
	},
	{
		kind: 'module' as const,
		artifactName: './i',
		entryPoint: 'src/i.ts',
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

test('isolated rebuild lists then stages once, chunks targets per isolate with bounded concurrency, and discards staging', async () => {
	resetMocks()

	const run = vi.fn(async () => ({
		ok: true,
		message: 'rebuilt',
		results: [],
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
	run.mockImplementation(async (input: { targets: typeof sampleTargets }) => {
		inFlight += 1
		maxInFlight = Math.max(maxInFlight, inFlight)
		await new Promise<void>((resolve) => {
			releaseGates.push(() => {
				inFlight -= 1
				resolve()
			})
		})
		return {
			ok: true,
			message: 'rebuilt',
			results: input.targets.map((target) => ({
				ok: true,
				message: 'rebuilt',
				target,
			})),
		}
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
	expect(run.mock.calls[0]?.[0]?.targets).toEqual(sampleTargets.slice(0, 4))
	expect(run.mock.calls[1]?.[0]?.targets).toEqual(sampleTargets.slice(4, 8))

	releaseGates.splice(0).forEach((release) => release())
	await vi.waitFor(() => {
		expect(run).toHaveBeenCalledTimes(3)
	})
	expect(touch).toHaveBeenCalledWith(
		'repo-artifact-rebuild-staging:v1:user-1:stage-1',
	)
	expect(run.mock.calls[2]?.[0]?.targets).toEqual(sampleTargets.slice(8))
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
			targets: sampleTargets.slice(0, 4),
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
		sampleTargets.slice(0, 3),
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
		expect.objectContaining({ targets: [sampleTargets[1]] }),
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

test('force rebuilds already-built targets so already_published can repair stale same-commit artifacts', async () => {
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
	mockModule.isPublishedPackageArtifactBuiltForCommit.mockResolvedValue(true)

	await rebuildPublishedPackageArtifactsViaRepoSession({
		env: {
			REPO_SESSION: {},
			BUNDLE_ARTIFACTS_KV: {},
		} as unknown as Env,
		rpcSessionId: 'session-1',
		sourceId: 'source-1',
		userId: 'user-1',
		publishedCommit: 'commit-1',
		baseUrl: 'https://kody.test',
		force: true,
	})

	expect(
		mockModule.isPublishedPackageArtifactBuiltForCommit,
	).not.toHaveBeenCalled()
	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledTimes(
		1,
	)
	expect(run).toHaveBeenCalledTimes(3)
	expect(run).toHaveBeenCalledWith(
		expect.objectContaining({
			force: true,
			targets: sampleTargets.slice(0, 4),
		}),
	)
	expect(discard).toHaveBeenCalledTimes(1)
})

test('rebuild failure stops later chunks and reports succeeded versus failed for isolated and fallback paths', async () => {
	const targets = sampleTargets
	const failurePattern =
		/Succeeded: \{ kind "module", artifact "\.", entry "src\/a\.ts", bundle "module" \}.+Failed:.+bundle b failed/

	resetMocks()
	const run = vi.fn(async (input: { targets: typeof targets }) => {
		return {
			ok: input.targets.every((target) => target.artifactName !== './b'),
			message: input.targets.some((target) => target.artifactName === './b')
				? 'bundle b failed'
				: 'rebuilt',
			results: input.targets.map((target) =>
				target.artifactName === './b'
					? { ok: false, message: 'bundle b failed', target }
					: { ok: true, message: 'rebuilt', target },
			),
		}
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
	expect(run).toHaveBeenCalledWith(
		expect.objectContaining({ targets: targets.slice(0, 4) }),
	)
	expect(run).toHaveBeenCalledWith(
		expect.objectContaining({ targets: targets.slice(4, 8) }),
	)
	expect(run).not.toHaveBeenCalledWith(
		expect.objectContaining({ targets: targets.slice(8) }),
	)
	expect(discard).toHaveBeenCalledWith(
		'repo-artifact-rebuild-staging:v1:user-1:stage-1',
	)

	resetMocks()
	mockModule.createIsolatedArtifactRebuildRunner.mockReturnValue(null)
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(
		targets.slice(0, 4),
	)
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
		sampleTargets.slice(0, 3),
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

test('retries transient platform errors during staging and target rebuild, then exhausts', async () => {
	consoleWarn.mockImplementation(() => {})
	resetMocks()

	const stagingRun = vi.fn(async () => ({
		ok: true,
		message: 'rebuilt',
	}))
	const stagingDiscard = vi.fn(async () => undefined)
	mockModule.createIsolatedArtifactRebuildRunner.mockReturnValue({
		touch: vi.fn(async () => undefined),
		run: stagingRun,
		discard: stagingDiscard,
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue([
		sampleTargets[0],
	])
	mockModule.stagePublishedPackageArtifactRebuild
		.mockRejectedValueOnce(
			new Error('Durable Object reset because its code was updated.'),
		)
		.mockResolvedValueOnce({
			stagingKey: 'repo-artifact-rebuild-staging:v1:user-1:stage-retry',
		})

	await rebuildPublishedPackageArtifactsViaRepoSession({
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

	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledTimes(
		2,
	)
	expect(stagingRun).toHaveBeenCalledTimes(1)
	expect(stagingDiscard).toHaveBeenCalledWith(
		'repo-artifact-rebuild-staging:v1:user-1:stage-retry',
	)
	expect(consoleWarn).toHaveBeenCalledTimes(1)
	expect(String(consoleWarn.mock.calls[0]?.[0])).toContain(
		'rebuildPublishedPackageArtifactsViaRepoSession transient platform error',
	)

	consoleWarn.mockClear()
	resetMocks()
	const d1Run = vi
		.fn()
		.mockResolvedValueOnce({
			ok: false,
			message: 'internal error; reference = s46pgsm6st3fg81p6qumom80',
		})
		.mockResolvedValueOnce({
			ok: true,
			message: 'rebuilt',
		})
	const d1Discard = vi.fn(async () => undefined)
	mockModule.createIsolatedArtifactRebuildRunner.mockReturnValue({
		touch: vi.fn(),
		run: d1Run,
		discard: d1Discard,
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue([
		sampleTargets[0],
	])
	mockModule.stagePublishedPackageArtifactRebuild.mockResolvedValue({
		stagingKey: 'repo-artifact-rebuild-staging:v1:user-1:stage-d1',
	})

	await rebuildPublishedPackageArtifactsViaRepoSession({
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

	expect(d1Run).toHaveBeenCalledTimes(2)
	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledTimes(
		2,
	)
	expect(d1Discard).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledTimes(1)
	expect(String(consoleWarn.mock.calls[0]?.[0])).toContain(
		'rebuildPublishedPackageArtifactsViaRepoSession transient platform error',
	)

	consoleWarn.mockClear()
	resetMocks()
	mockModule.createIsolatedArtifactRebuildRunner.mockReturnValue({
		touch: vi.fn(),
		run: vi.fn(),
		discard: vi.fn(),
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue([
		sampleTargets[0],
	])
	mockModule.stagePublishedPackageArtifactRebuild.mockRejectedValue(
		new Error('Durable Object reset because its code was updated.'),
	)

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
	).rejects.toThrow(
		/could not recover after 3 transient platform error attempts/,
	)

	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledTimes(
		3,
	)
	expect(consoleWarn).toHaveBeenCalledTimes(3)
})

test('does not retry non-transient rebuild failures', async () => {
	resetMocks()

	mockModule.createIsolatedArtifactRebuildRunner.mockReturnValue({
		touch: vi.fn(),
		run: vi.fn(),
		discard: vi.fn(),
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue([
		sampleTargets[0],
	])
	mockModule.stagePublishedPackageArtifactRebuild.mockRejectedValue(
		new Error('staging kv unavailable'),
	)

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
	).rejects.toThrow(/bundle artifact rebuild failed/i)

	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledTimes(
		1,
	)

	resetMocks()
	const run = vi.fn().mockResolvedValue({
		ok: false,
		message: 'No matching default export for import "default"',
	})
	mockModule.createIsolatedArtifactRebuildRunner.mockReturnValue({
		touch: vi.fn(),
		run,
		discard: vi.fn(),
	})
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue([
		sampleTargets[0],
	])
	mockModule.stagePublishedPackageArtifactRebuild.mockResolvedValue({
		stagingKey: 'repo-artifact-rebuild-staging:v1:user-1:stage-compile',
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
	).rejects.toThrow(/bundle artifact rebuild failed/i)

	expect(run).toHaveBeenCalledTimes(1)
	expect(mockModule.stagePublishedPackageArtifactRebuild).toHaveBeenCalledTimes(
		1,
	)
})
