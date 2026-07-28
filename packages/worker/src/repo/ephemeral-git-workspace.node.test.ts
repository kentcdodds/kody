import rawGit from 'isomorphic-git'
import { expect, test } from 'vitest'
import { createEphemeralGitWorkspace } from './ephemeral-git-workspace.ts'

type RawGitInitFs = Parameters<typeof rawGit.init>[0]['fs']

test('ephemeral git workspace preserves and follows symlinks', async () => {
	const workspace = createEphemeralGitWorkspace()
	await workspace.fs.promises.mkdir('/repo', { recursive: true })
	await workspace.fs.promises.writeFile(
		'/repo/target.txt',
		new TextEncoder().encode('target contents'),
	)
	await workspace.fs.promises.symlink('target.txt', '/repo/link.txt')

	const linkStat = await workspace.fs.promises.lstat('/repo/link.txt')
	const targetStat = await workspace.fs.promises.stat('/repo/link.txt')
	expect(linkStat.isSymbolicLink()).toBe(true)
	expect(targetStat.isFile()).toBe(true)
	expect(await workspace.fs.promises.readlink('/repo/link.txt')).toBe(
		'target.txt',
	)
	expect(
		new TextDecoder().decode(
			await workspace.fs.promises.readFile('/repo/link.txt'),
		),
	).toBe('target contents')
})

test('ephemeral git workspace normalizes dot paths so isomorphic-git checkout can walk the workdir root', async () => {
	const workspace = createEphemeralGitWorkspace()
	const fs = workspace.fs as RawGitInitFs

	await rawGit.init({ fs, dir: workspace.dir, defaultBranch: 'main' })
	await workspace.fs.promises.writeFile(
		'/repo/README.md',
		new TextEncoder().encode('hello\n'),
	)
	await rawGit.add({ fs, dir: workspace.dir, filepath: 'README.md' })
	const oid = await rawGit.commit({
		fs,
		dir: workspace.dir,
		message: 'Initial commit',
		author: { name: 'Kody Test', email: 'test@local.invalid' },
	})

	// isomorphic-git's workdir walker stats `${dir}/.` for the root entry.
	const rootDot = await workspace.fs.promises.lstat('/repo/.')
	expect(rootDot.isDirectory()).toBe(true)

	await expect(
		rawGit.checkout({ fs, dir: workspace.dir, ref: oid }),
	).resolves.toBeUndefined()
	expect(
		new TextDecoder().decode(
			await workspace.fs.promises.readFile('/repo/README.md'),
		),
	).toBe('hello\n')
})
