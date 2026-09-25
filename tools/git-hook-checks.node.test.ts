import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	hookScripts,
	isDocsOnlyHookPath,
	listHookPaths,
	parsePrePushUpdates,
	planGitHookChecks,
	runGitHookChecks,
	type GitRunner,
} from './git-hook-checks.ts'

const zeroSha = '0'.repeat(40)
const remoteSha = 'a'.repeat(40)
const localSha = 'b'.repeat(40)
const otherSha = 'd'.repeat(40)

function gitResult(status: number, stdout = ''): ReturnType<GitRunner> {
	return { status, stdout, stderr: '' }
}

test('docs-only hook paths skip expensive checks and any code path keeps them', async () => {
	expect(isDocsOnlyHookPath('docs/contributing/security.md')).toBe(true)
	expect(
		isDocsOnlyHookPath('docs/contributing/architecture/primitives.yaml'),
	).toBe(true)
	expect(isDocsOnlyHookPath('./README.md')).toBe(true)
	expect(isDocsOnlyHookPath('notes.mdx')).toBe(true)
	expect(isDocsOnlyHookPath('LICENSE')).toBe(true)

	expect(isDocsOnlyHookPath('docs-site/guide.ts')).toBe(false)
	expect(isDocsOnlyHookPath('src/readme.md.ts')).toBe(false)
	expect(isDocsOnlyHookPath('packages/worker/src/app.ts')).toBe(false)
	expect(isDocsOnlyHookPath('../packages/worker/src/app.ts')).toBe(false)
	expect(isDocsOnlyHookPath('docs\\feature.ts')).toBe(false)

	const docsPaths = ['docs/contributing/security.md', 'README.md', 'LICENSE']
	expect(
		planGitHookChecks({ hook: 'pre-commit', paths: docsPaths }),
	).toMatchObject({
		runTypecheck: false,
		runMigrationsCheck: false,
		runUnitTests: false,
		summary:
			'pre-commit: skipping typecheck and migrations:check (3 docs-only paths)',
	})
	expect(
		hookScripts(planGitHookChecks({ hook: 'pre-push', paths: docsPaths })),
	).toEqual([])

	const codePaths = [
		'docs/contributing/security.md',
		'packages/worker/src/app.ts',
	]
	expect(
		hookScripts(planGitHookChecks({ hook: 'pre-commit', paths: codePaths })),
	).toEqual(['typecheck', 'migrations:check'])
	expect(
		planGitHookChecks({ hook: 'pre-push', paths: codePaths }).summary,
	).toBe('pre-push: running test:push (packages/worker/src/app.ts)')
	expect(
		hookScripts(
			planGitHookChecks({
				hook: 'pre-push',
				paths: ['packages/worker/migrations/0067-example.sql'],
			}),
		),
	).toEqual(['test:push'])

	expect(
		hookScripts(planGitHookChecks({ hook: 'pre-commit', paths: [] })),
	).toEqual([])
	expect(
		hookScripts(planGitHookChecks({ hook: 'pre-commit', paths: null })),
	).toEqual(['typecheck', 'migrations:check'])
	expect(
		hookScripts(planGitHookChecks({ hook: 'pre-push', paths: null })),
	).toEqual(['test:push'])

	expect(parsePrePushUpdates(null)).toBeNull()
	expect(parsePrePushUpdates('\n')).toBeNull()
	expect(
		parsePrePushUpdates(
			`refs/heads/docs ${localSha} refs/heads/docs not-a-sha\n`,
		),
	).toBeNull()

	const skipped: Array<string> = []
	const skippedCode = await runGitHookChecks({
		hook: 'pre-commit',
		git: () => gitResult(0, 'docs/contributing/security.md\0README.md\0'),
		runScript: (script) => {
			skipped.push(script)
			return 0
		},
		log: () => {},
	})
	expect(skippedCode).toBe(0)
	expect(skipped).toEqual([])

	const ran: Array<string> = []
	const failedCode = await runGitHookChecks({
		hook: 'pre-commit',
		git: () => gitResult(0, 'packages/worker/src/app.ts\0'),
		runScript: (script) => {
			ran.push(script)
			return script === 'typecheck' ? 2 : 0
		},
		log: () => {},
	})
	expect(failedCode).toBe(2)
	expect(ran).toEqual(['typecheck'])

	const pushed: Array<string> = []
	const pushCode = await runGitHookChecks({
		hook: 'pre-push',
		stdin: ' \n',
		git: () => {
			throw new Error('blank pre-push stdin must fail closed before git')
		},
		runScript: (script) => {
			pushed.push(script)
			return 0
		},
		log: () => {},
	})
	expect(pushCode).toBe(0)
	expect(pushed).toEqual(['test:push'])
})

test('push path listing diffs the remote tip and fails closed without a new-branch base', () => {
	const calls: Array<ReadonlyArray<string>> = []
	const git: GitRunner = (args) => {
		calls.push(args)
		if (args[0] === 'diff' && args.at(-1) === localSha) {
			return gitResult(0, 'docs/contributing/security.md\0')
		}
		if (args[0] === 'diff' && args.at(-1) === otherSha) {
			return gitResult(0, 'packages/worker/src/app.ts\0README.md\0')
		}
		return gitResult(1)
	}

	expect(
		listHookPaths({
			hook: 'pre-push',
			git,
			stdin: `refs/heads/docs ${localSha} refs/heads/docs ${remoteSha}\n`,
		}),
	).toEqual(['docs/contributing/security.md'])
	expect(calls).toEqual([
		['diff', '--name-only', '--no-renames', '-z', remoteSha, localSha],
	])

	expect(
		listHookPaths({
			hook: 'pre-push',
			git,
			stdin: [
				`refs/heads/docs ${localSha} refs/heads/docs ${remoteSha}`,
				`refs/heads/code ${otherSha} refs/heads/code ${remoteSha}`,
			].join('\n'),
		}),
	).toEqual([
		'README.md',
		'docs/contributing/security.md',
		'packages/worker/src/app.ts',
	])

	const deleteCalls: Array<string> = []
	expect(
		listHookPaths({
			hook: 'pre-push',
			git: (args) => {
				deleteCalls.push(args.join(' '))
				return gitResult(0)
			},
			stdin: `refs/heads/old ${zeroSha} refs/heads/old ${remoteSha}\n`,
		}),
	).toEqual([])
	expect(deleteCalls).toEqual([])

	const missingBaseCalls: Array<string> = []
	expect(
		listHookPaths({
			hook: 'pre-push',
			git: (args) => {
				missingBaseCalls.push(args.join(' '))
				return gitResult(1)
			},
			stdin: `refs/heads/main ${localSha} refs/heads/main ${zeroSha}\n`,
		}),
	).toBeNull()
	expect(missingBaseCalls).toEqual([
		'rev-parse --verify --quiet origin/HEAD^{commit}',
		'rev-parse --verify --quiet origin/main^{commit}',
	])

	expect(
		listHookPaths({
			hook: 'pre-commit',
			git: () => gitResult(1, ''),
		}),
	).toBeNull()
})

test('a real docs follow-up skips unit tests and a source rename still typechecks', async () => {
	const root = await mkdtemp(join(tmpdir(), 'git-hook-checks-'))
	const script = fileURLToPath(new URL('./git-hook-checks.ts', import.meta.url))
	const git = (args: ReadonlyArray<string>) => {
		const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
		if ((result.status ?? 1) !== 0) {
			throw new Error(
				`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
			)
		}
		return result.stdout.trim()
	}
	const runner: GitRunner = (args) => {
		const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
		return {
			status: result.status ?? 1,
			stdout: result.stdout ?? '',
			stderr: result.stderr ?? '',
		}
	}

	try {
		git(['init', '-b', 'main'])
		git(['config', 'user.email', 'hooks@example.com'])
		git(['config', 'user.name', 'Hook Test'])
		const isolatedHooks = join(root, 'no-hooks')
		await mkdir(isolatedHooks)
		git(['config', 'core.hooksPath', isolatedHooks])
		await mkdir(join(root, 'docs', 'contributing'), { recursive: true })
		await mkdir(join(root, 'src'), { recursive: true })
		await writeFile(join(root, 'src', 'app.ts'), 'export const value = 1\n')
		await writeFile(
			join(root, 'docs', 'contributing', 'security.md'),
			'# Security\n',
		)
		git(['add', '.'])
		git(['commit', '-m', 'base'])
		const base = git(['rev-parse', 'HEAD'])

		await writeFile(
			join(root, 'docs', 'contributing', 'security.md'),
			'# Security\n\nDocs only.\n',
		)
		git(['add', 'docs/contributing/security.md'])
		expect(
			hookScripts(
				planGitHookChecks({
					hook: 'pre-commit',
					paths: listHookPaths({ hook: 'pre-commit', git: runner }),
				}),
			),
		).toEqual([])
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				scripts: {
					typecheck: 'exit 3',
					'migrations:check': 'exit 4',
					'test:push': 'exit 5',
				},
			}),
		)
		const preCommit = spawnSync(process.execPath, [script, 'pre-commit'], {
			cwd: root,
			encoding: 'utf8',
		})
		expect(preCommit.status).toBe(0)
		expect(preCommit.stdout).toContain(
			'pre-commit: skipping typecheck and migrations:check (1 docs-only path)',
		)
		git(['commit', '-m', 'docs'])
		const docsCommit = git(['rev-parse', 'HEAD'])

		const pushStdin = `refs/heads/main ${docsCommit} refs/heads/main ${base}\n`
		expect(
			hookScripts(
				planGitHookChecks({
					hook: 'pre-push',
					paths: listHookPaths({
						hook: 'pre-push',
						git: runner,
						stdin: pushStdin,
					}),
				}),
			),
		).toEqual([])
		const prePush = spawnSync(process.execPath, [script, 'pre-push'], {
			cwd: root,
			encoding: 'utf8',
			input: pushStdin,
		})
		expect(prePush.status).toBe(0)
		expect(prePush.stdout).toContain(
			'pre-push: skipping test:push (1 docs-only path)',
		)

		git(['checkout', '-b', 'feature', base])
		await writeFile(
			join(root, 'src', 'app.ts'),
			'export const value = 2 // comment\n',
		)
		git(['add', 'src/app.ts'])
		git(['commit', '-m', 'code'])
		const feature = git(['rev-parse', 'HEAD'])
		expect(
			listHookPaths({
				hook: 'pre-push',
				git: runner,
				stdin: `refs/heads/feature ${feature} refs/heads/feature ${zeroSha}\n`,
			}),
		).toEqual(['src/app.ts'])
		expect(
			hookScripts(
				planGitHookChecks({
					hook: 'pre-push',
					paths: ['src/app.ts'],
				}),
			),
		).toEqual(['test:push'])

		git(['checkout', 'main'])
		git(['mv', 'src/app.ts', 'src/app.md'])
		expect(listHookPaths({ hook: 'pre-commit', git: runner })).toEqual([
			'src/app.md',
			'src/app.ts',
		])
		expect(
			hookScripts(
				planGitHookChecks({
					hook: 'pre-commit',
					paths: ['src/app.md', 'src/app.ts'],
				}),
			),
		).toEqual(['typecheck', 'migrations:check'])
		const renamedCommit = spawnSync(process.execPath, [script, 'pre-commit'], {
			cwd: root,
			encoding: 'utf8',
		})
		expect(renamedCommit.status).not.toBe(0)
		expect(renamedCommit.stdout).toContain(
			'pre-commit: running typecheck and migrations:check (src/app.ts)',
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
