import { expect, test } from 'vitest'
import { buildPublishCommitDiff } from '#app/package-publish-diff.ts'

test('buildPublishCommitDiff classifies added, removed, and modified files', () => {
	const diff = buildPublishCommitDiff(
		{
			'README.md': '# Hello\n',
			'gone.ts': 'export const gone = true\n',
			'same.ts': 'export const same = 1\n',
		},
		{
			'README.md': '# Hello world\n',
			'new.ts': 'export const added = true\n',
			'same.ts': 'export const same = 1\n',
		},
	)

	expect(diff.omittedCount).toBe(0)
	expect(diff.files.map((file) => [file.path, file.status])).toEqual([
		['gone.ts', 'removed'],
		['new.ts', 'added'],
		['README.md', 'modified'],
	])
	expect(diff.files[0]?.patch).toContain('-export const gone = true')
	expect(diff.files[1]?.patch).toContain('+export const added = true')
	expect(diff.files[2]?.patch).toContain('-# Hello')
	expect(diff.files[2]?.patch).toContain('+# Hello world')
})

test('buildPublishCommitDiff omits identical trees and binary or oversized files', () => {
	expect(buildPublishCommitDiff({ 'a.ts': 'one' }, { 'a.ts': 'one' })).toEqual({
		files: [],
		omittedCount: 0,
	})

	const huge = 'x'.repeat(80_001)
	const binary = 'ok\0nope'
	const diff = buildPublishCommitDiff(
		{ 'huge.txt': 'old', 'bin.dat': 'plain' },
		{ 'huge.txt': huge, 'bin.dat': binary },
	)
	expect(diff.files).toEqual([
		{ path: 'bin.dat', status: 'modified', patch: null },
		{ path: 'huge.txt', status: 'modified', patch: null },
	])
})
