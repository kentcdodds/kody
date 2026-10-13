import { expect, test } from 'vitest'
import { parseGitCredentialRepoPath } from './git-http-target.ts'

test('parseGitCredentialRepoPath accepts @owner/name.git shapes', () => {
	expect(parseGitCredentialRepoPath('/@kent/cloudflare.git')).toEqual({
		ownerHandle: 'kent',
		repoName: 'cloudflare',
	})
	expect(parseGitCredentialRepoPath('kent/cloudflare.git/info/refs')).toEqual({
		ownerHandle: 'kent',
		repoName: 'cloudflare',
	})
})

test('parseGitCredentialRepoPath returns null for invalid percent-encoding', () => {
	expect(parseGitCredentialRepoPath('/@kent/%E0%A4%A.git')).toBeNull()
})
