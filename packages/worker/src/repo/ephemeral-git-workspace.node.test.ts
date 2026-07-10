import { expect, test } from 'vitest'
import { createEphemeralGitWorkspace } from './ephemeral-git-workspace.ts'

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
