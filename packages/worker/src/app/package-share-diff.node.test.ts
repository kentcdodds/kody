import { expect, test } from 'vitest'
import { diffPublishedSourceFiles } from './package-share-diff.ts'

test('diffPublishedSourceFiles reports added, removed, and modified files', () => {
	expect(
		diffPublishedSourceFiles(
			{
				'README.md': '# old',
				'gone.ts': 'export const gone = 1',
				'same.ts': 'export const same = 1',
			},
			{
				'README.md': '# new',
				'added.ts': 'export const added = 1',
				'same.ts': 'export const same = 1',
			},
		),
	).toEqual([
		{
			path: 'added.ts',
			change: 'added',
			accepted: null,
			current: 'export const added = 1',
			truncated: false,
		},
		{
			path: 'gone.ts',
			change: 'removed',
			accepted: 'export const gone = 1',
			current: null,
			truncated: false,
		},
		{
			path: 'README.md',
			change: 'modified',
			accepted: '# old',
			current: '# new',
			truncated: false,
		},
	])
})

test('diffPublishedSourceFiles marks truncated files', () => {
	const huge = 'x'.repeat(40_001)
	expect(
		diffPublishedSourceFiles({ 'big.ts': huge }, { 'big.ts': `${huge}y` }),
	).toEqual([
		{
			path: 'big.ts',
			change: 'modified',
			accepted: `${huge.slice(0, 40_000)}\n\n… truncated for review …`,
			current: `${huge.slice(0, 40_000)}\n\n… truncated for review …`,
			truncated: true,
		},
	])
})
