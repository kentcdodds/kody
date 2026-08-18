import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mocks.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		mocks.loadPackageManifestBySourceId(...args),
}))

import {
	findStaticKodyDependencyCycle,
	formatStaticKodyDependencyCycleMessage,
	loadReachableStaticKodyDependencyEdges,
} from './static-dependency-cycles.ts'

test('findStaticKodyDependencyCycle reports the path through a loop and ignores acyclic or missing roots', () => {
	expect(
		findStaticKodyDependencyCycle({
			rootPackageName: '@scope/a',
			edges: new Map([
				['@scope/a', ['@scope/b']],
				['@scope/b', ['@scope/a']],
				['@scope/c', ['@scope/d']],
			]),
		}),
	).toEqual(['@scope/a', '@scope/b', '@scope/a'])
	expect(
		findStaticKodyDependencyCycle({
			rootPackageName: '@scope/c',
			edges: new Map([
				['@scope/c', ['@scope/d']],
				['@scope/d', ['@scope/e']],
				['@scope/e', ['@scope/c']],
			]),
		}),
	).toEqual(['@scope/c', '@scope/d', '@scope/e', '@scope/c'])
	expect(
		findStaticKodyDependencyCycle({
			rootPackageName: '@scope/c',
			edges: new Map([
				['@scope/a', ['@scope/b']],
				['@scope/b', ['@scope/a']],
				['@scope/c', ['@scope/d']],
			]),
		}),
	).toBeNull()
	expect(
		findStaticKodyDependencyCycle({
			rootPackageName: '@scope/missing',
			edges: new Map([['@scope/a', ['@scope/b']]]),
		}),
	).toBeNull()
	expect(
		formatStaticKodyDependencyCycleMessage([
			'@scope/a',
			'@scope/b',
			'@scope/a',
		]),
	).toBe(
		'package.json#kody.dependencies forms a cycle: @scope/a -> @scope/b -> @scope/a.',
	)
})

test('loadReachableStaticKodyDependencyEdges walks published sibling manifests and treats missing or unloadable packages as sinks', async () => {
	mocks.listSavedPackagesByUserId.mockReset()
	mocks.loadPackageManifestBySourceId.mockReset()
	mocks.listSavedPackagesByUserId.mockResolvedValue([
		{ name: '@scope/b', sourceId: 'source-b' },
		{ name: '@scope/c', sourceId: 'source-c' },
	])
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-b') {
				return {
					manifest: { kody: { dependencies: ['@scope/c', '@scope/missing'] } },
				}
			}
			throw new Error('manifest unavailable')
		},
	)

	const edges = await loadReachableStaticKodyDependencyEdges({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://example.test',
		userId: 'user-1',
		rootPackageName: '@scope/a',
		rootDependencies: ['@scope/b', ' @scope/b '],
	})

	expect(edges.get('@scope/a')).toEqual(['@scope/b'])
	expect(edges.get('@scope/b')).toEqual(['@scope/c', '@scope/missing'])
	expect(edges.get('@scope/c')).toEqual([])
	expect(edges.get('@scope/missing')).toEqual([])
	expect(mocks.loadPackageManifestBySourceId).toHaveBeenCalledTimes(2)
	expect(
		findStaticKodyDependencyCycle({
			rootPackageName: '@scope/a',
			edges,
		}),
	).toBeNull()
})
