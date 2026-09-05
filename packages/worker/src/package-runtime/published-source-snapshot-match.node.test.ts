import { expect, test } from 'vitest'
import {
	publishedSourceSnapshotFilesMatch,
	type PublishedSourceSnapshot,
} from './published-runtime-artifacts.ts'

function snapshotWithFiles(
	files: Record<string, string>,
): PublishedSourceSnapshot {
	return {
		version: 1,
		sourceId: 'source-1',
		repoId: 'repo-1',
		entityKind: 'package',
		entityId: 'package-1',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		sourceRoot: '/',
		files,
		createdAt: '2026-09-05T00:00:00.000Z',
	}
}

test('publishedSourceSnapshotFilesMatch requires the same paths and contents', () => {
	const files = {
		'package.json': '{"name":"@kody/demo"}',
		'index.ts': 'export const ready = true\n',
	}
	expect(publishedSourceSnapshotFilesMatch(null, files)).toBe(false)
	expect(
		publishedSourceSnapshotFilesMatch(
			snapshotWithFiles({ 'package.json': files['package.json'] }),
			files,
		),
	).toBe(false)
	expect(
		publishedSourceSnapshotFilesMatch(
			snapshotWithFiles({
				...files,
				'extra.ts': 'export const extra = true\n',
			}),
			files,
		),
	).toBe(false)
	expect(
		publishedSourceSnapshotFilesMatch(
			snapshotWithFiles({
				...files,
				'index.ts': 'export const ready = false\n',
			}),
			files,
		),
	).toBe(false)
	expect(
		publishedSourceSnapshotFilesMatch(snapshotWithFiles(files), files),
	).toBe(true)
})
