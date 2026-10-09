import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	gitHookScriptEnv,
	hookScripts,
	isDocsOnlyHookPath,
	listHookPaths,
	parsePrePushUpdates,
	isSkillsLockHookPath,
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

function plannedScripts(
	hook: 'pre-commit' | 'pre-push',
	paths: ReadonlyArray<string> | null,
) {
	return hookScripts(planGitHookChecks({ hook, paths }))
}

async function runHook(
	input: Omit<Parameters<typeof runGitHookChecks>[0], 'runScript' | 'log'>,
	exitCodeFor: (script: string) => number = () => 0,
) {
	const scripts: Array<string> = []
	const code = await runGitHookChecks({
		...input,
		runScript: (script) => {
			scripts.push(script)
			return exitCodeFor(script)
		},
		log: () => {},
	})
	return { code, scripts }
}

test('docs-only hook paths skip expensive checks and any code path keeps them', async () => {
	const pathCases: Array<[string, boolean]> = [
		['docs/contributing/security.md', true],
		['docs/contributing/architecture/primitives.yaml', true],
		['./README.md', true],
		['notes.mdx', true],
		['LICENSE', true],
		['docs-site/guide.ts', false],
		['src/readme.md.ts', false],
		['packages/worker/src/app.ts', false],
		['../packages/worker/src/app.ts', false],
		['docs\\feature.ts', false],
	]
	expect(
		pathCases.filter(
			([filePath, want]) => isDocsOnlyHookPath(filePath) !== want,
		),
	).toEqual([])

	const docsPaths = ['docs/contributing/security.md', 'README.md', 'LICENSE']
	const codePaths = [
		'docs/contributing/security.md',
		'packages/worker/src/app.ts',
	]
	expect(
		planGitHookChecks({ hook: 'pre-commit', paths: docsPaths }),
	).toMatchObject({
		runTypecheck: false,
		runMigrationsCheck: false,
		runUnitTests: false,
		summary:
			'pre-commit: skipping install:check, typecheck, and migrations:check (3 docs-only paths)',
	})
	expect(
		planGitHookChecks({ hook: 'pre-push', paths: codePaths }).summary,
	).toBe('pre-push: running test:push (packages/worker/src/app.ts)')
	const planCases: Array<
		['pre-commit' | 'pre-push', Array<string> | null, Array<string>]
	> = [
		['pre-push', docsPaths, []],
		[
			'pre-commit',
			codePaths,
			['install:check', 'typecheck', 'migrations:check'],
		],
		[
			'pre-push',
			['packages/worker/migrations/0067-example.sql'],
			['test:push'],
		],
		['pre-commit', [], []],
		['pre-commit', null, ['install:check', 'typecheck', 'migrations:check']],
		['pre-push', null, ['skills-lock:check', 'test:push']],
	]
	expect(
		planCases.map(([hook, paths]) => [
			hook,
			paths,
			plannedScripts(hook, paths),
		]),
	).toEqual(planCases)

	expect(parsePrePushUpdates(null)).toBeNull()
	expect(parsePrePushUpdates('\n')).toBeNull()
	expect(
		parsePrePushUpdates(
			`refs/heads/docs ${localSha} refs/heads/docs not-a-sha\n`,
		),
	).toBeNull()

	expect(
		await runHook({
			hook: 'pre-commit',
			git: () => gitResult(0, 'docs/contributing/security.md\0README.md\0'),
		}),
	).toEqual({ code: 0, scripts: [] })
	expect(
		await runHook(
			{
				hook: 'pre-commit',
				git: () => gitResult(0, 'packages/worker/src/app.ts\0'),
			},
			(script) => (script === 'install:check' ? 2 : 0),
		),
	).toEqual({ code: 2, scripts: ['install:check'] })
	expect(
		await runHook(
			{
				hook: 'pre-commit',
				git: () => gitResult(0, 'packages/worker/src/app.ts\0'),
			},
			(script) => (script === 'typecheck' ? 2 : 0),
		),
	).toEqual({ code: 2, scripts: ['install:check', 'typecheck'] })
	expect(
		await runHook({
			hook: 'pre-push',
			stdin: ' \n',
			git: () => {
				throw new Error('blank pre-push stdin must fail closed before git')
			},
		}),
	).toEqual({ code: 0, scripts: ['skills-lock:check', 'test:push'] })

	expect(isSkillsLockHookPath('.agents/skills/ship-pr/SKILL.md')).toBe(true)
	expect(isSkillsLockHookPath('./skills-lock.json')).toBe(true)
	expect(isSkillsLockHookPath('README.md')).toBe(false)
	expect(
		plannedScripts('pre-push', ['.agents/skills/ship-pr/SKILL.md']),
	).toEqual(['skills-lock:check'])
	expect(
		plannedScripts('pre-commit', ['.agents/skills/ship-pr/SKILL.md']),
	).toEqual([])
	expect(
		planGitHookChecks({
			hook: 'pre-push',
			paths: ['.agents/skills/ship-pr/SKILL.md', 'README.md'],
		}).summary,
	).toBe(
		'pre-push: running skills-lock:check (.agents/skills/ship-pr/SKILL.md)',
	)
	expect(
		plannedScripts('pre-push', [
			'.agents/skills/ship-pr/SKILL.md',
			'skills-lock.json',
		]),
	).toEqual(['skills-lock:check'])
	expect(
		plannedScripts('pre-push', [
			'.agents/skills/visual-recap/scripts/primitives-map.mjs',
		]),
	).toEqual(['skills-lock:check', 'test:push'])
	expect(
		plannedScripts('pre-push', [
			'.agents/skills/visual-recap/scripts/primitives-map.mjs',
			'skills-lock.json',
		]),
	).toEqual(['skills-lock:check', 'test:push'])
	expect(
		plannedScripts('pre-push', [
			'.agents/skills/ship-pr/SKILL.md',
			'packages/worker/src/app.ts',
		]),
	).toEqual(['skills-lock:check', 'test:push'])
	expect(
		planGitHookChecks({
			hook: 'pre-push',
			paths: ['skills-lock.json', 'packages/worker/src/app.ts'],
		}).summary,
	).toBe(
		'pre-push: running skills-lock:check and test:push (packages/worker/src/app.ts)',
	)
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
			plannedScripts(
				'pre-commit',
				listHookPaths({ hook: 'pre-commit', git: runner }),
			),
		).toEqual([])
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				scripts: {
					'install:check': 'exit 2',
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
			'pre-commit: skipping install:check, typecheck, and migrations:check (1 docs-only path)',
		)
		git(['commit', '-m', 'docs'])
		const docsCommit = git(['rev-parse', 'HEAD'])

		const pushStdin = `refs/heads/main ${docsCommit} refs/heads/main ${base}\n`
		expect(
			plannedScripts(
				'pre-push',
				listHookPaths({ hook: 'pre-push', git: runner, stdin: pushStdin }),
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
		expect(plannedScripts('pre-push', ['src/app.ts'])).toEqual(['test:push'])

		git(['checkout', 'main'])
		git(['mv', 'src/app.ts', 'src/app.md'])
		expect(listHookPaths({ hook: 'pre-commit', git: runner })).toEqual([
			'src/app.md',
			'src/app.ts',
		])
		expect(plannedScripts('pre-commit', ['src/app.md', 'src/app.ts'])).toEqual([
			'install:check',
			'typecheck',
			'migrations:check',
		])
		const renamedCommit = spawnSync(process.execPath, [script, 'pre-commit'], {
			cwd: root,
			encoding: 'utf8',
		})
		expect(renamedCommit.status).not.toBe(0)
		expect(renamedCommit.stdout).toContain(
			'pre-commit: running install:check, typecheck, and migrations:check (src/app.ts)',
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('hook scripts can create foreign repositories without inherited worktree state', async () => {
	const root = await mkdtemp(join(tmpdir(), 'hook-env-'))
	try {
		const env = gitHookScriptEnv({
			...process.env,
			GIT_DIR: join(root, 'wrong.git'),
			GIT_WORK_TREE: join(root, 'wrong-worktree'),
			GIT_INDEX_FILE: join(root, 'wrong-index'),
			KODY_HOOK_TEST: 'preserved',
		})
		expect(env.KODY_HOOK_TEST).toBe('preserved')
		const target = join(root, 'fixture')
		const init = spawnSync('git', ['init', target], { env, encoding: 'utf8' })
		expect({ status: init.status, error: init.error }).toEqual({
			status: 0,
			error: undefined,
		})
		const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
			cwd: target,
			env,
			encoding: 'utf8',
		})
		expect({ status: top.status, error: top.error }).toEqual({
			status: 0,
			error: undefined,
		})
		expect(top.stdout.trim()).toBe(await realpath(target))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
