import { expect, test, vi } from 'vitest'
import { publishedPackageArtifactRebuildConcurrency } from './package-artifact-rebuild.ts'

const mockModule = vi.hoisted(() => ({
	listPublishedPackageArtifactTargets: vi.fn(),
	rebuildPublishedPackageArtifact: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: () => ({
		listPublishedPackageArtifactTargets: (...args: Array<unknown>) =>
			mockModule.listPublishedPackageArtifactTargets(...args),
		rebuildPublishedPackageArtifact: (...args: Array<unknown>) =>
			mockModule.rebuildPublishedPackageArtifact(...args),
	}),
}))

const { rebuildPublishedPackageArtifactsViaRepoSession } =
	await import('./package-artifact-rebuild.ts')

test('rebuildPublishedPackageArtifactsViaRepoSession pipelines targets with bounded concurrency', async () => {
	expect(publishedPackageArtifactRebuildConcurrency).toBe(2)

	const targets = [
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
	mockModule.listPublishedPackageArtifactTargets.mockResolvedValue(targets)

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

	releaseGates.splice(0).forEach((release) => release())
	await vi.waitFor(() => {
		expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(3)
	})
	releaseGates.splice(0).forEach((release) => release())
	await rebuildPromise

	expect(maxInFlight).toBe(2)
	expect(mockModule.rebuildPublishedPackageArtifact).toHaveBeenCalledTimes(3)
})
