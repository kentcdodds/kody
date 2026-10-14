import { spawn, spawnSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveNpmCommand, isExecutedDirectly } from './node-runtime.ts'
import {
	createFileProvenanceStore,
	hasProvenanceCheck,
	hasUntrackedFiles,
	recordProvenanceCheck,
	treeShaForCommit,
	treeShaForWorktree,
	type ProvenanceStore,
} from './git-hook-provenance.ts'

/**
 * Husky pre-commit and pre-push gates.
 *
 * A docs-only diff skips install:check, typecheck, migrations:check, and
 * test:push. lint-staged still formats the commit. Any other path, including
 * a comment in a source file, keeps the full check for that hook. An
 * unreadable diff fails closed and runs the check.
 *
 * pre-push also runs skills-lock:check when the push changes skills-lock.json
 * or a path under .agents/skills/, and when the pushed paths cannot be listed.
 * Markdown skill files are docs-only, so they do not run test:push.
 * skills-lock.json alone does not either. Executable files under
 * .agents/skills/ still run test:push.
 *
 * Rename detection is off so a source file renamed to markdown still lists
 * the deleted path.
 *
 * Pre-push skips `test:push` when the pushed commit's tree SHA is already
 * recorded green from `npm run validate` or a prior successful pre-push
 * (#3653 / #3719). Progress logs tick every 30s so a long workers-unit run is
 * not a silent hang (#3547). Workers-unit isolation (ADR 0011) is unchanged.
 *
 * Pre-commit typecheck runs against the staged tree (worktree reset to the
 * index, then unstaged/untracked restored) so unstaged fixes cannot
 * greenlight a broken index (#3695). Avoids `stash --keep-index` + `pop`,
 * which 3-way-merges and conflicts on MM paths.
 */

export type GitHookName = 'pre-commit' | 'pre-push'

type GitCommandResult = {
	status: number
	stdout: string
	stderr: string
}

export type GitRunner = (args: ReadonlyArray<string>) => GitCommandResult

export type GitHookCheckPlan = {
	runInstallCheck: boolean
	runTypecheck: boolean
	runMigrationsCheck: boolean
	runUnitTests: boolean
	runSkillsLockCheck: boolean
	summary: string
}

type PrePushUpdate = {
	localRef: string
	localSha: string
	remoteSha: string
}

const prePushLinePattern =
	/^(?<localRef>\S+) (?<localSha>[0-9a-f]{40}) (?<remoteRef>\S+) (?<remoteSha>[0-9a-f]{40})$/i

const markdownExtensionPattern = /\.(?:md|mdx|mdc)$/i

const licenseBasenamePattern =
	/^(?:license|licence|copying|notice)(?:\.(?:md|txt))?$/i

const newRefBaseCandidates = ['origin/HEAD', 'origin/main', 'main'] as const

/** Heartbeat while a long hook script (test:push) inherits silence from vitest. */
export const gitHookProgressIntervalMs = 30_000

function normalizeHookPath(filePath: string) {
	// Git path output uses `/` even on Windows. A literal backslash is part of
	// the filename, so do not treat it as a separator.
	return filePath.replace(/^\.\//, '')
}

export function isDocsOnlyHookPath(filePath: string) {
	const path = normalizeHookPath(filePath)
	if (path.length === 0 || path.startsWith('../') || path.includes('/../')) {
		return false
	}
	if (path.startsWith('docs/')) return true
	if (markdownExtensionPattern.test(path)) return true
	const basename = path.slice(path.lastIndexOf('/') + 1)
	return licenseBasenamePattern.test(basename)
}

export function planGitHookChecks(input: {
	hook: GitHookName
	paths: ReadonlyArray<string> | null
}): GitHookCheckPlan {
	switch (input.hook) {
		case 'pre-commit':
			return planPreCommit(input.paths)
		case 'pre-push':
			return planPrePush(input.paths)
		default: {
			const exhaustive: never = input.hook
			throw new Error(`Unhandled git hook: ${exhaustive}`)
		}
	}
}

export function hookScripts(plan: GitHookCheckPlan) {
	const scripts: Array<string> = []
	if (plan.runInstallCheck) scripts.push('install:check')
	if (plan.runTypecheck) scripts.push('typecheck')
	if (plan.runMigrationsCheck) scripts.push('migrations:check')
	if (plan.runSkillsLockCheck) scripts.push('skills-lock:check')
	if (plan.runUnitTests) scripts.push('test:push')
	return scripts
}

export function listHookPaths(input: {
	hook: GitHookName
	git: GitRunner
	stdin?: string | null
}): ReadonlyArray<string> | null {
	switch (input.hook) {
		case 'pre-commit':
			return listDiffPaths(input.git, [
				'diff',
				'--cached',
				'--name-only',
				'--no-renames',
				'-z',
			])
		case 'pre-push':
			return listPushedPaths(input.git, input.stdin ?? null)
		default: {
			const exhaustive: never = input.hook
			throw new Error(`Unhandled git hook: ${exhaustive}`)
		}
	}
}

export function pushedCommitShas(stdin: string | null): ReadonlyArray<string> {
	const updates = parsePrePushUpdates(stdin)
	if (updates === null) return []
	return updates
		.filter((update) => !isZeroSha(update.localSha))
		.map((update) => update.localSha)
}

export function shouldSkipTestPushForProvenance(input: {
	git: GitRunner
	stdin?: string | null
	store: ProvenanceStore
}): { skip: boolean; treeSha: string | null; reason: string | null } {
	const shas = pushedCommitShas(input.stdin ?? null)
	if (shas.length === 0) {
		return { skip: false, treeSha: null, reason: null }
	}
	const trees: Array<string> = []
	for (const sha of shas) {
		const treeSha = treeShaForCommit(input.git, sha)
		if (!treeSha) {
			return { skip: false, treeSha: null, reason: null }
		}
		trees.push(treeSha)
	}
	const unique = [...new Set(trees)]
	if (unique.length !== 1) {
		return { skip: false, treeSha: null, reason: null }
	}
	const treeSha = unique[0]!
	if (!hasProvenanceCheck(input.store, 'test:push', treeSha)) {
		return { skip: false, treeSha, reason: null }
	}
	return {
		skip: true,
		treeSha,
		reason: `pre-push: skipping test:push (tree ${treeSha.slice(0, 12)} already green)`,
	}
}

type StagedTreeIsolation = {
	/** Absolute path to a `git diff` patch of unstaged tracked changes. */
	patchPath: string | null
	/** Temp dir holding moved-aside untracked paths (relative layout preserved). */
	holdDir: string | null
	untrackedPaths: ReadonlyArray<string>
}

function parseDirtyWorktreePaths(porcelainStdout: string) {
	const porcelainLine = /^(?:\?\?|[ MADRCU!][ MADRCU!]) /
	const unstagedTracked: Array<string> = []
	const untracked: Array<string> = []
	for (const raw of porcelainStdout.split('\n')) {
		const line = raw.trimEnd()
		if (!porcelainLine.test(line)) continue
		if (line.startsWith('?? ')) {
			untracked.push(line.slice(3))
			continue
		}
		// Porcelain XY: second column is worktree; space means clean.
		if (line[1] !== ' ') {
			const pathPart = line.slice(3)
			// Rename/copy: `R  old -> new` / `RM old -> new`
			const arrow = pathPart.indexOf(' -> ')
			unstagedTracked.push(arrow === -1 ? pathPart : pathPart.slice(arrow + 4))
		}
	}
	return { unstagedTracked, untracked }
}

/**
 * Hide unstaged / untracked work so typecheck sees the index about to be
 * committed (#3695). Uses `git diff` + `checkout -- .` + `git apply`, and
 * moves untracked aside — not `stash --keep-index`/`pop`, which conflicts on
 * MM paths.
 */
export async function withStagedTreeForTypecheck<T>(input: {
	git: GitRunner
	run: () => T | Promise<T>
	log?: (message: string) => void
	/** Repo root for patch + hold dirs (tests inject a temp root). */
	repoRoot?: string
}): Promise<T> {
	const log = input.log ?? (() => {})
	const repoRoot = input.repoRoot ?? process.cwd()
	const status = input.git(['status', '--porcelain', '-uall'])
	if (status.status !== 0) {
		log('pre-commit: could not read worktree status; typechecking as-is')
		return input.run()
	}
	const { unstagedTracked, untracked } = parseDirtyWorktreePaths(status.stdout)
	if (unstagedTracked.length === 0 && untracked.length === 0) {
		return input.run()
	}
	log('pre-commit: typechecking staged tree (hiding unstaged changes)')

	let isolation: StagedTreeIsolation
	try {
		isolation = captureUnstagedIsolation(input.git, untracked, repoRoot)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		log(`pre-commit: staged-tree isolation failed (${message})`)
		return 1 as T
	}

	const hide = hideUnstagedForTypecheck(input.git)
	if (hide !== null) {
		log(`pre-commit: could not reset worktree to index (${hide})`)
		restoreUnstagedAfterTypecheck(input.git, isolation, repoRoot)
		return 1 as T
	}

	let runError: unknown
	let result: T
	try {
		result = await input.run()
	} catch (error) {
		runError = error
		result = 1 as T
	}
	const restoreError = restoreUnstagedAfterTypecheck(
		input.git,
		isolation,
		repoRoot,
	)
	if (runError) throw runError
	if (restoreError !== null) {
		log(
			`pre-commit: failed to restore unstaged work after typecheck (${restoreError}). Patch/hold under .tmp if present; resolve manually, then retry the commit.`,
		)
		return 1 as T
	}
	return result
}

function captureUnstagedIsolation(
	git: GitRunner,
	untracked: ReadonlyArray<string>,
	repoRoot: string,
): StagedTreeIsolation {
	const diff = git(['diff', '--binary', '--full-index'])
	if (diff.status !== 0) {
		throw new Error(diff.stderr.trim() || 'git diff failed')
	}
	let patchPath: string | null = null
	if (diff.stdout.length > 0) {
		const tmpRoot = join(repoRoot, '.tmp')
		mkdirSync(tmpRoot, { recursive: true })
		patchPath = join(tmpRoot, `kody-pre-commit-unstaged-${process.pid}.patch`)
		writeFileSync(patchPath, diff.stdout)
	}
	let holdDir: string | null = null
	if (untracked.length > 0) {
		holdDir = mkdtempSync(join(tmpdir(), 'kody-pre-commit-untracked-'))
		for (const relative of untracked) {
			const from = join(repoRoot, relative)
			const to = join(holdDir, relative)
			if (!existsSync(from)) continue
			mkdirSync(dirname(to), { recursive: true })
			renameSync(from, to)
		}
	}
	return { patchPath, holdDir, untrackedPaths: untracked }
}

function hideUnstagedForTypecheck(git: GitRunner): string | null {
	const checkout = git(['checkout', '--', '.'])
	if (checkout.status !== 0) {
		return checkout.stderr.trim() || 'git checkout -- . failed'
	}
	return null
}

function restoreUnstagedAfterTypecheck(
	git: GitRunner,
	isolation: StagedTreeIsolation,
	repoRoot: string,
): string | null {
	let error: string | null = null
	if (isolation.patchPath) {
		const apply = git(['apply', '--whitespace=nowarn', isolation.patchPath])
		if (apply.status !== 0) {
			error = apply.stderr.trim() || apply.stdout.trim() || 'git apply failed'
		} else {
			try {
				rmSync(isolation.patchPath, { force: true })
			} catch {
				// Best-effort cleanup.
			}
		}
	}
	if (isolation.holdDir) {
		for (const relative of isolation.untrackedPaths) {
			const from = join(isolation.holdDir, relative)
			const to = join(repoRoot, relative)
			if (!existsSync(from)) continue
			try {
				mkdirSync(dirname(to), { recursive: true })
				renameSync(from, to)
			} catch (moveError) {
				const message =
					moveError instanceof Error ? moveError.message : String(moveError)
				error = error ?? `restore untracked ${relative}: ${message}`
			}
		}
		if (error === null) {
			try {
				rmSync(isolation.holdDir, { recursive: true, force: true })
			} catch {
				// Best-effort cleanup.
			}
		}
	}
	return error
}

export async function runGitHookChecks(input: {
	hook: GitHookName
	stdin?: string | null
	git?: GitRunner
	runScript?: (script: string) => number | Promise<number>
	log?: (message: string) => void
	provenance?: ProvenanceStore
	now?: () => number
	progressIntervalMs?: number
}) {
	const git = input.git ?? defaultGit
	const runScript = input.runScript ?? defaultRunNpmScript
	const log = input.log ?? console.log
	const provenance = input.provenance ?? createFileProvenanceStore()
	const now = input.now ?? Date.now
	const progressIntervalMs =
		input.progressIntervalMs ?? gitHookProgressIntervalMs
	const paths = listHookPaths({
		hook: input.hook,
		git,
		stdin: input.stdin,
	})
	const plan = planGitHookChecks({ hook: input.hook, paths })
	log(plan.summary)

	let scripts = hookScripts(plan)
	if (input.hook === 'pre-push' && scripts.includes('test:push')) {
		const skip = shouldSkipTestPushForProvenance({
			git,
			stdin: input.stdin,
			store: provenance,
		})
		if (skip.skip && skip.reason) {
			log(skip.reason)
			scripts = scripts.filter((script) => script !== 'test:push')
		}
	}

	for (const script of scripts) {
		const started = now()
		log(`hook: starting npm run ${script}`)
		const heartbeat = setInterval(() => {
			const elapsedSec = Math.max(1, Math.round((now() - started) / 1000))
			log(`hook: still running npm run ${script} (${elapsedSec}s)`)
		}, progressIntervalMs)
		// Unref so a stuck interval cannot keep the process alive after exit.
		heartbeat.unref?.()
		let status: number
		// Provenance must bind to the tree that was actually tested, not
		// whatever commit tips appear on stdin (#3745 review). Skip the
		// fingerprint when stdin has no pushable SHAs (blank / delete-only).
		const pushShas =
			script === 'test:push' ? pushedCommitShas(input.stdin ?? null) : []
		const testedTreeBefore =
			pushShas.length > 0 ? treeShaForWorktree(git) : null
		try {
			if (input.hook === 'pre-commit' && script === 'typecheck') {
				status = await withStagedTreeForTypecheck({
					git,
					log,
					run: () => runScript(script),
				})
			} else {
				status = await runScript(script)
			}
		} finally {
			clearInterval(heartbeat)
		}
		const elapsedSec = Math.max(0, Math.round((now() - started) / 1000))
		log(`hook: finished npm run ${script} in ${elapsedSec}s (exit ${status})`)
		if (status !== 0) return status
		if (script === 'test:push' && pushShas.length > 0) {
			if (hasUntrackedFiles(git)) {
				log(
					'pre-push: not recording test:push provenance (untracked files present; stash create cannot fingerprint them)',
				)
				continue
			}
			const testedTreeAfter = treeShaForWorktree(git)
			if (
				!testedTreeBefore ||
				!testedTreeAfter ||
				testedTreeBefore !== testedTreeAfter
			) {
				log(
					'pre-push: not recording test:push provenance (worktree changed during the run or could not be fingerprinted)',
				)
				continue
			}
			for (const sha of pushShas) {
				const commitTree = treeShaForCommit(git, sha)
				if (!commitTree || commitTree !== testedTreeAfter) continue
				recordProvenanceCheck(provenance, {
					check: 'test:push',
					treeSha: commitTree,
					source: 'pre-push',
				})
			}
		}
	}
	return 0
}

function planPreCommit(paths: ReadonlyArray<string> | null): GitHookCheckPlan {
	if (paths === null) {
		return {
			runInstallCheck: true,
			runTypecheck: true,
			runMigrationsCheck: true,
			runUnitTests: false,
			runSkillsLockCheck: false,
			summary:
				'pre-commit: running install:check, typecheck, and migrations:check (could not list staged paths)',
		}
	}
	if (paths.every(isDocsOnlyHookPath)) {
		return {
			runInstallCheck: false,
			runTypecheck: false,
			runMigrationsCheck: false,
			runUnitTests: false,
			runSkillsLockCheck: false,
			summary: `pre-commit: skipping install:check, typecheck, and migrations:check (${docsOnlySummary(paths)})`,
		}
	}
	return {
		runInstallCheck: true,
		runTypecheck: true,
		runMigrationsCheck: true,
		runUnitTests: false,
		runSkillsLockCheck: false,
		summary: `pre-commit: running install:check, typecheck, and migrations:check (${codePathSummary(paths)})`,
	}
}

function planPrePush(paths: ReadonlyArray<string> | null): GitHookCheckPlan {
	if (paths === null) {
		return {
			runInstallCheck: false,
			runTypecheck: false,
			runMigrationsCheck: false,
			runUnitTests: true,
			runSkillsLockCheck: true,
			summary:
				'pre-push: running test:push and skills-lock:check (could not list pushed paths)',
		}
	}
	const skillsLock = paths.some(isSkillsLockHookPath)
	// skills-lock.json is not markdown. Markdown under .agents/skills/ is
	// already docs-only. Executable skill scripts (.mjs, tests) are not, so
	// they still run test:push.
	if (paths.every(skipsPrePushUnitTests)) {
		if (skillsLock) {
			return {
				runInstallCheck: false,
				runTypecheck: false,
				runMigrationsCheck: false,
				runUnitTests: false,
				runSkillsLockCheck: true,
				summary: `pre-push: running skills-lock:check (${skillsLockPathSummary(paths)})`,
			}
		}
		return {
			runInstallCheck: false,
			runTypecheck: false,
			runMigrationsCheck: false,
			runUnitTests: false,
			runSkillsLockCheck: false,
			summary: `pre-push: skipping test:push (${docsOnlySummary(paths)})`,
		}
	}
	return {
		runInstallCheck: false,
		runTypecheck: false,
		runMigrationsCheck: false,
		runUnitTests: true,
		runSkillsLockCheck: skillsLock,
		summary: skillsLock
			? `pre-push: running skills-lock:check and test:push (${codePathSummary(paths)})`
			: `pre-push: running test:push (${codePathSummary(paths)})`,
	}
}

export function isSkillsLockHookPath(filePath: string) {
	const normalized = normalizeHookPath(filePath)
	return (
		normalized === 'skills-lock.json' ||
		normalized.startsWith('.agents/skills/')
	)
}

function skipsPrePushUnitTests(filePath: string) {
	return (
		isDocsOnlyHookPath(filePath) ||
		normalizeHookPath(filePath) === 'skills-lock.json'
	)
}

function skillsLockPathSummary(paths: ReadonlyArray<string>) {
	const skillPaths = paths.filter(isSkillsLockHookPath).sort()
	return skillPaths[0] ?? 'skills-lock.json'
}

function docsOnlySummary(paths: ReadonlyArray<string>) {
	if (paths.length === 0) return 'no file changes'
	const count = String(paths.length)
	return `${count} docs-only path${paths.length === 1 ? '' : 's'}`
}

function codePathSummary(paths: ReadonlyArray<string>) {
	const codePaths = paths.filter((path) => !isDocsOnlyHookPath(path)).sort()
	return codePaths[0] ?? 'a non-docs path'
}

function listPushedPaths(
	git: GitRunner,
	stdin: string | null,
): ReadonlyArray<string> | null {
	const updates = parsePrePushUpdates(stdin)
	if (updates === null) return null

	const paths = new Set<string>()
	for (const update of updates) {
		if (isZeroSha(update.localSha)) continue
		const from = isZeroSha(update.remoteSha)
			? resolveNewRefBase(git, update.localRef, update.localSha)
			: update.remoteSha
		if (from === null) return null
		const diff = listDiffPaths(git, [
			'diff',
			'--name-only',
			'--no-renames',
			'-z',
			from,
			update.localSha,
		])
		if (diff === null) return null
		for (const path of diff) paths.add(path)
	}
	return [...paths].sort()
}

export function parsePrePushUpdates(
	stdin: string | null,
): ReadonlyArray<PrePushUpdate> | null {
	if (stdin === null) return null
	const updates: Array<PrePushUpdate> = []
	for (const rawLine of stdin.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (line.length === 0) continue
		const match = prePushLinePattern.exec(line)
		const localRef = match?.groups?.localRef
		const localSha = match?.groups?.localSha
		const remoteSha = match?.groups?.remoteSha
		if (!localRef || !localSha || !remoteSha) return null
		updates.push({ localRef, localSha, remoteSha })
	}
	if (updates.length === 0) return null
	return updates
}

function resolveNewRefBase(
	git: GitRunner,
	localRef: string,
	localSha: string,
): string | null {
	const localBranch = localRef.startsWith('refs/heads/')
		? localRef.slice('refs/heads/'.length)
		: null
	for (const candidate of newRefBaseCandidates) {
		if (candidate === localBranch) continue
		const resolved = git([
			'rev-parse',
			'--verify',
			'--quiet',
			`${candidate}^{commit}`,
		])
		if (resolved.status !== 0) continue
		const base = git(['merge-base', candidate, localSha])
		if (base.status !== 0) continue
		const sha = base.stdout.trim()
		if (/^[0-9a-f]{40}$/i.test(sha)) return sha
	}
	return null
}

function listDiffPaths(
	git: GitRunner,
	args: ReadonlyArray<string>,
): ReadonlyArray<string> | null {
	const result = git(args)
	if (result.status !== 0) return null
	const paths = result.stdout
		.split('\0')
		.map((path) => normalizeHookPath(path))
		.filter((path) => path.length > 0)
	return [...new Set(paths)].sort()
}

function isZeroSha(sha: string) {
	return /^0{40}$/i.test(sha)
}

function defaultGit(args: ReadonlyArray<string>): GitCommandResult {
	const result = spawnSync('git', args, { encoding: 'utf8' })
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	}
}

export function gitHookScriptEnv(source: NodeJS.ProcessEnv = process.env) {
	const result = defaultGit(['rev-parse', '--local-env-vars'])
	if (result.status !== 0) {
		throw new Error(
			'Could not isolate Git hook checks from repository environment',
		)
	}
	const env = { ...source }
	// Tests create foreign repositories. Inherited worktree variables would
	// redirect their Git commands back into the repository being pushed.
	for (const name of result.stdout.trim().split(/\s+/)) delete env[name]
	return env
}

function defaultRunNpmScript(script: string): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(resolveNpmCommand(), ['run', script], {
			stdio: 'inherit',
			env: gitHookScriptEnv(),
		})
		child.once('error', (error) => {
			console.error(error.message)
			resolve(1)
		})
		child.once('close', (code) => {
			resolve(code ?? 1)
		})
	})
}

async function readHookStdin() {
	if (process.stdin.isTTY) return null
	const chunks: Array<Buffer> = []
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}

async function main() {
	const hook = process.argv[2]
	if (hook !== 'pre-commit' && hook !== 'pre-push') {
		console.error('git-hook-checks: expected pre-commit or pre-push')
		process.exitCode = 1
		return
	}
	process.exitCode = await runGitHookChecks({
		hook,
		stdin: hook === 'pre-push' ? await readHookStdin() : undefined,
	})
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
