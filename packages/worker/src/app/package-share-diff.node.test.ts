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
		},
		{
			path: 'gone.ts',
			change: 'removed',
			accepted: 'export const gone = 1',
			current: null,
		},
		{
			path: 'README.md',
			change: 'modified',
			accepted: '# old',
			current: '# new',
		},
	])
})
