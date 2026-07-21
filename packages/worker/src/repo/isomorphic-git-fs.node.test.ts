import { InMemoryFs } from '@cloudflare/shell'
import rawGit from 'isomorphic-git'
import { expect, test } from 'vitest'
import { createIsomorphicGitFs } from './isomorphic-git-fs.ts'

type RawGitInitFs = Parameters<typeof rawGit.init>[0]['fs']
type RawGitPushHttp = Parameters<typeof rawGit.push>[0]['http']

test('bare workspace filesystem trips isomorphic-git bindFs without unlink/rmdir', async () => {
	// WorkspaceFileSystem / InMemoryFs expose `rm` but not Node's unlink/rmdir.
	// isomorphic-git's FileSystem constructor eagerly does fs[command].bind(fs)
	// and throws "Cannot read properties of undefined (reading 'bind')" for the
	// first missing command — the production cron cleanup failure mode when
	// rawGit.push received a bare workspace fs.
	const workspaceFileSystem = new InMemoryFs()
	await workspaceFileSystem.mkdir('/session', { recursive: true })
	await expect(
		rawGit.init({
			fs: workspaceFileSystem as unknown as RawGitInitFs,
			dir: '/session',
			defaultBranch: 'main',
		}),
	).rejects.toThrow(/reading 'bind'/)
})

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

	await rawGit.addRemote({
		fs,
		dir: '/session',
		remote: 'origin',
		url: 'https://artifacts.invalid/repo.git',
	})
	const transportReached = new Error('raw Git push reached HTTP transport')
	const http = {
		request: async () => {
			throw transportReached
		},
	} as RawGitPushHttp

	await expect(
		rawGit.push({
			fs,
			http,
			dir: '/session',
			remote: 'origin',
			ref: 'main',
		}),
	).rejects.toBe(transportReached)

	await workspaceFileSystem.writeFile('/remove-me.txt', 'temporary')
	await workspaceFileSystem.mkdir('/remove-me')
	await fs.promises.unlink('/remove-me.txt')
	await fs.promises.rmdir('/remove-me')
	await expect(workspaceFileSystem.stat('/remove-me.txt')).rejects.toThrow()
	await expect(workspaceFileSystem.stat('/remove-me')).rejects.toThrow()
})
