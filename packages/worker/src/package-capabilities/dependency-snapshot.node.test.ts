import { expect, test } from 'vitest'
import {
	canonicalizeDependencySnapshot,
	emptyDependencySnapshot,
	parseDependencySnapshotJson,
	serializeDependencySnapshot,
} from './dependency-snapshot.ts'

test('serialize round-trips and sorts dependencies', () => {
	const snapshot = canonicalizeDependencySnapshot({
		version: 1,
		root: {
			packageId: 'pkg-root',
			kodyId: 'root',
			sourceId: 'src-root',
			publishedCommit: 'commit-root',
		},
		dependencies: [
			{
				sourceId: 'src-b',
				publishedCommit: 'commit-b',
				kodyId: 'b',
				packageId: 'pkg-b',
				transitive: true,
			},
			{
				sourceId: 'src-a',
				publishedCommit: 'commit-a',
				kodyId: 'a',
				packageId: 'pkg-a',
				packageName: '@user/a',
			},
		],
	})
	const json = serializeDependencySnapshot(snapshot)
	const parsed = parseDependencySnapshotJson(json)
	expect(parsed).toEqual(snapshot)
	expect(parsed?.dependencies.map((dependency) => dependency.kodyId)).toEqual([
		'a',
		'b',
	])
})

test('parse treats empty object as null (PR1 placeholder)', () => {
	expect(parseDependencySnapshotJson('{}')).toBeNull()
	expect(parseDependencySnapshotJson(null)).toBeNull()
	expect(
		emptyDependencySnapshot({
			packageId: 'pkg',
			kodyId: 'leaf',
			sourceId: 'src',
			publishedCommit: 'abc',
		}).dependencies,
	).toEqual([])
})
