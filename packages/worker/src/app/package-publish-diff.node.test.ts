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
		['README.md', 'modified'],
		['gone.ts', 'removed'],
		['new.ts', 'added'],
	])
	expect(diff.files[0]?.patch).toContain('-# Hello')
	expect(diff.files[0]?.patch).toContain('+# Hello world')
	expect(diff.files[1]?.patch).toContain('-export const gone = true')
	expect(diff.files[2]?.patch).toContain('+export const added = true')
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

	const iconA = new TextDecoder('latin1').decode(
		Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1]),
	)
	const iconB = new TextDecoder('latin1').decode(
		Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 2]),
	)
	expect(
		buildPublishCommitDiff(
			{ 'community-icon.png': iconA },
			{ 'community-icon.png': iconA },
		),
	).toEqual({ files: [], omittedCount: 0 })
	expect(
		buildPublishCommitDiff(
			{ 'community-icon.png': iconA },
			{ 'community-icon.png': iconB },
		).files,
	).toEqual([{ path: 'community-icon.png', status: 'modified', patch: null }])
})

test('buildPublishCommitDiff uses code-unit path order and own-property reads', () => {
	const diff = buildPublishCommitDiff(
		{
			'é.md': 'old accent',
			'z.md': 'old z',
		},
		{
			'A.md': 'new A',
			'é.md': 'new accent',
		},
	)
	expect(diff.files.map((file) => file.path)).toEqual(['A.md', 'z.md', 'é.md'])

	const inheritedName = buildPublishCommitDiff(
		Object.fromEntries([['toString', 'old']]) as Record<string, string>,
		{},
	)
	expect(inheritedName.files).toEqual([
		{
			path: 'toString',
			status: 'removed',
			patch: expect.stringContaining('-old'),
		},
	])
})
