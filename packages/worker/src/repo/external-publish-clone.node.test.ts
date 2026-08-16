import { expect, test, vi } from 'vitest'
import {
	buildWorkspaceSqliteTooBigCallerMessage,
	isWorkspaceSqliteTooBigMessage,
} from './external-publish-clone.ts'

const gitMocks = vi.hoisted(() => ({
	clone: vi.fn(async () => undefined),
	log: vi.fn(async () => [{ oid: 'commit-head' }]),
	checkout: vi.fn(async () => undefined),
	listFiles: vi.fn(async () => ['package.json', 'src/index.ts']),
}))

vi.mock('isomorphic-git', () => ({
	default: {
		clone: (...args: Array<unknown>) => gitMocks.clone(...args),
		log: (...args: Array<unknown>) => gitMocks.log(...args),
		checkout: (...args: Array<unknown>) => gitMocks.checkout(...args),
		listFiles: (...args: Array<unknown>) => gitMocks.listFiles(...args),
	},
}))

vi.mock('isomorphic-git/http/web', () => ({
	default: {},
}))

vi.mock('./artifacts-git-retry.ts', () => ({
	runArtifactsGitWithRetry: async <T>(operation: () => Promise<T>) =>
		await operation(),
	wrapArtifactsGitHttpError: (input: {
		operation: string
		remote: string
		error: unknown
	}) =>
		new Error(
			`Artifacts ${input.operation} failed for ${input.remote}: ${String(input.error)}`,
		),
	isTransientArtifactsGitError: () => false,
}))

const { cloneExternalPublishWorkspace } =
	await import('./external-publish-clone.ts')

test('isWorkspaceSqliteTooBigMessage matches DO SQL row-limit wording', () => {
	expect(
		isWorkspaceSqliteTooBigMessage('string or blob too big: SQLITE_TOOBIG'),
	).toBe(true)
	expect(
		isWorkspaceSqliteTooBigMessage(
			'source clone or commit checkout failed: string or blob too big: SQLITE_TOOBIG',
		),
	).toBe(true)
	expect(isWorkspaceSqliteTooBigMessage('D1 DB is overloaded')).toBe(false)
	expect(
		buildWorkspaceSqliteTooBigCallerMessage('Repo session clone'),
	).toContain('2 MiB row limit')
})

test('cloneExternalPublishWorkspace clones into ephemeral FS and exposes publish helpers', async () => {
	gitMocks.clone.mockClear()
	gitMocks.log.mockClear()
	gitMocks.checkout.mockClear()
	gitMocks.listFiles.mockClear()
	gitMocks.log
		.mockResolvedValueOnce([{ oid: 'commit-head' }])
		.mockResolvedValueOnce([{ oid: 'commit-new' }, { oid: 'commit-old' }])

	const cloned = await cloneExternalPublishWorkspace({
		remote: 'https://acct.artifacts.cloudflare.net/git/default/source-repo.git',
		token: 'art_token',
		branch: 'main',
		checkoutCommit: 'commit-new',
	})

	expect(gitMocks.clone).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/repo',
			ref: 'main',
			singleBranch: true,
		}),
	)
	expect(gitMocks.checkout).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/repo',
			ref: 'commit-new',
			force: true,
		}),
	)
	expect(cloned.headCommit).toBe('commit-head')
	expect(cloned.dir).toBe('/repo')
	await expect(
		cloned.isAncestorCommit({
			ancestor: 'commit-old',
			descendant: 'commit-new',
		}),
	).resolves.toBe(true)

	await cloned.filesystem.writeFile('/repo/package.json', '{"name":"@kody/x"}')
	await expect(cloned.workspace.readFile('/repo/package.json')).resolves.toBe(
		'{"name":"@kody/x"}',
	)
	const globbed = await cloned.workspace.glob('**/*')
	expect(globbed).toEqual([
		{ path: '/repo/package.json', type: 'file' },
		{ path: '/repo/src/index.ts', type: 'file' },
	])
	// runRepoChecks passes normalizeRepoWorkspacePath('/repo') + '/**/*' → 'repo/**/*'
	await expect(cloned.workspace.glob('repo/**/*')).resolves.toEqual([
		{ path: '/repo/package.json', type: 'file' },
		{ path: '/repo/src/index.ts', type: 'file' },
	])
	await expect(cloned.workspace.glob('repo/src/**/*')).resolves.toEqual([
		{ path: '/repo/src/index.ts', type: 'file' },
	])
})
