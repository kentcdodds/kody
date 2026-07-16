import { InMemoryFs } from '@cloudflare/shell'
import rawGit from 'isomorphic-git'
import { expect, test } from 'vitest'
import { createIsomorphicGitFs } from './isomorphic-git-fs.ts'

type RawGitInitFs = Parameters<typeof rawGit.init>[0]['fs']

test('workspace filesystem adapter supports raw isomorphic-git operations', async () => {
	const workspaceFileSystem = new InMemoryFs()
	await workspaceFileSystem.mkdir('/session', { recursive: true })
	const fs = createIsomorphicGitFs(workspaceFileSystem) as RawGitInitFs

	await rawGit.init({ fs, dir: '/session', defaultBranch: 'main' })
	await workspaceFileSystem.writeFile('/session/README.md', 'hello\n')
	await rawGit.add({ fs, dir: '/session', filepath: 'README.md' })
	const commit = await rawGit.commit({
		fs,
		dir: '/session',
		message: 'Initial commit',
		author: {
			name: 'Kody Test',
			email: 'test@local.invalid',
		},
	})

	expect(await rawGit.resolveRef({ fs, dir: '/session', ref: 'HEAD' })).toBe(
		commit,
	)
})

test('workspace filesystem adapter implements isomorphic-git deletion methods', async () => {
	const workspaceFileSystem = new InMemoryFs()
	const fs = createIsomorphicGitFs(workspaceFileSystem)

	await workspaceFileSystem.writeFile('/remove-me.txt', 'temporary')
	await workspaceFileSystem.mkdir('/remove-me')

	await fs.promises.unlink('/remove-me.txt')
	await fs.promises.rmdir('/remove-me')

	await expect(workspaceFileSystem.stat('/remove-me.txt')).rejects.toThrow()
	await expect(workspaceFileSystem.stat('/remove-me')).rejects.toThrow()
})
