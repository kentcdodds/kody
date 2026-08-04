import { expect, test } from 'vitest'
import {
	isRepoLargeFileMessage,
	maxRepoSourceFileBytes,
} from '#worker/repo/large-file-policy.ts'
import { runRepoSourceWalkChecks } from '#worker/repo/checks.ts'

test('runRepoSourceWalkChecks accepts small trees and rejects oversized files', async () => {
	const ok = await runRepoSourceWalkChecks({
		workspace: {
			readFile: async (path) => (path === 'README.md' ? '# hello' : null),
			glob: async () => [{ path: 'README.md', type: 'file' }],
		},
		sourceRoot: '/',
	})
	expect(ok.ok).toBe(true)
	expect(ok.sourceFiles['README.md']).toBe('# hello')

	const oversized = 'x'.repeat(maxRepoSourceFileBytes + 1)
	const rejected = await runRepoSourceWalkChecks({
		workspace: {
			readFile: async (path) => (path === 'big.txt' ? oversized : null),
			glob: async () => [{ path: 'big.txt', type: 'file' }],
		},
		sourceRoot: '/',
	})
	expect(rejected.ok).toBe(false)
	expect(isRepoLargeFileMessage(rejected.message ?? '')).toBe(true)
})
