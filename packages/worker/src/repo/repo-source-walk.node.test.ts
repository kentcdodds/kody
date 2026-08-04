import { expect, test } from 'vitest'
import { maxRepoSourceFileBytes } from '#worker/repo/large-file-policy.ts'
import { runRepoSourceWalkChecks } from '#worker/repo/checks.ts'

test('runRepoSourceWalkChecks rejects oversized files', async () => {
	const oversized = 'x'.repeat(maxRepoSourceFileBytes + 1)
	const result = await runRepoSourceWalkChecks({
		workspace: {
			readFile: async (path) => (path === 'big.txt' ? oversized : null),
			glob: async () => [{ path: 'big.txt', type: 'file' }],
		},
		sourceRoot: '/',
	})
	expect(result.ok).toBe(false)
	expect(result.message).toContain('per-file limit')
})

test('runRepoSourceWalkChecks accepts small trees', async () => {
	const result = await runRepoSourceWalkChecks({
		workspace: {
			readFile: async (path) => (path === 'README.md' ? '# hello' : null),
			glob: async () => [{ path: 'README.md', type: 'file' }],
		},
		sourceRoot: '/',
	})
	expect(result.ok).toBe(true)
	expect(result.sourceFiles['README.md']).toBe('# hello')
})
