import { expect, test } from 'vitest'
import { loadOptionalSearchRows } from './search.ts'

test('optional search rows fall back when saved skills lookup fails', async () => {
	const result = await loadOptionalSearchRows({
		userId: 'user-123',
		loadSkills: async () => {
			throw new Error('D1 skills unavailable')
		},
		loadUiArtifacts: async () => [
			{
				id: 'app-123',
				user_id: 'user-123',
				title: 'Roku remote',
				description: 'Saved remote UI',
				keywords: 'roku remote',
				code: '<div />',
				runtime: 'html',
				search_text: 'roku remote',
				created_at: '2026-03-24T00:00:00.000Z',
				updated_at: '2026-03-24T00:00:00.000Z',
			},
		],
	})

	expect(result.skillRows).toEqual([])
	expect(result.uiArtifactRows).toHaveLength(1)
	expect(result.warnings).toEqual([
		'Saved skills are temporarily unavailable: D1 skills unavailable',
	])
})

test('optional search rows fall back when saved apps lookup fails', async () => {
	const result = await loadOptionalSearchRows({
		userId: 'user-123',
		loadSkills: async () => [],
		loadUiArtifacts: async () => {
			throw new Error('D1 apps unavailable')
		},
	})

	expect(result.skillRows).toEqual([])
	expect(result.uiArtifactRows).toEqual([])
	expect(result.warnings).toEqual([
		'Saved apps are temporarily unavailable: D1 apps unavailable',
	])
})

test('optional search rows skip D1 access without a user', async () => {
	const result = await loadOptionalSearchRows({
		userId: null,
		loadSkills: async () => {
			throw new Error('should not run')
		},
		loadUiArtifacts: async () => {
			throw new Error('should not run')
		},
	})

	expect(result).toEqual({
		skillRows: [],
		uiArtifactRows: [],
		warnings: [],
	})
})
