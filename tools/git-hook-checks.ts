import { spawnSync } from 'node:child_process'
import { resolveNpmCommand, isExecutedDirectly } from './node-runtime.ts'

/**
 * Husky pre-commit and pre-push gates.
 *
 * A docs-only diff skips typecheck, migrations:check, and test:push.
 * lint-staged still formats the commit. Any other path, including a comment
 * in a source file, keeps the full check for that hook. An unreadable diff
 * fails closed and runs the check.
 *
 * Rename detection is off so a source file renamed to markdown still lists
 * the deleted path.
 */

export type GitHookName = 'pre-commit' | 'pre-push'

type GitCommandResult = {
	status: number
	stdout: string
	stderr: string
}

export type GitRunner = (args: ReadonlyArray<string>) => GitCommandResult

export type GitHookCheckPlan = {
	runTypecheck: boolean
	runMigrationsCheck: boolean
	runUnitTests: boolean
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

function normalizeHookPath(filePath: string) {
	return filePath.replaceAll('\\', '/').replace(/^\.?\//, '')
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
	if (plan.runTypecheck) scripts.push('typecheck')
	if (plan.runMigrationsCheck) scripts.push('migrations:check')
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

export async function runGitHookChecks(input: {
	hook: GitHookName
	stdin?: string | null
	git?: GitRunner
	runScript?: (script: string) => number
	log?: (message: string) => void
}) {
	const git = input.git ?? defaultGit
	const runScript = input.runScript ?? runNpmScript
	const log = input.log ?? console.log
	const paths = listHookPaths({
		hook: input.hook,
		git,
		stdin: input.stdin,
	})
	const plan = planGitHookChecks({ hook: input.hook, paths })
	log(plan.summary)
	for (const script of hookScripts(plan)) {
		const status = runScript(script)
		if (status !== 0) return status
	}
	return 0
}

function planPreCommit(paths: ReadonlyArray<string> | null): GitHookCheckPlan {
	if (paths === null) {
		return {
			runTypecheck: true,
			runMigrationsCheck: true,
			runUnitTests: false,
			summary:
				'pre-commit: running typecheck and migrations:check (could not list staged paths)',
		}
	}
	if (paths.every(isDocsOnlyHookPath)) {
		return {
			runTypecheck: false,
			runMigrationsCheck: false,
			runUnitTests: false,
			summary: `pre-commit: skipping typecheck and migrations:check (${docsOnlySummary(paths)})`,
		}
	}
	return {
		runTypecheck: true,
		runMigrationsCheck: true,
		runUnitTests: false,
		summary: `pre-commit: running typecheck and migrations:check (${codePathSummary(paths)})`,
	}
}

function planPrePush(paths: ReadonlyArray<string> | null): GitHookCheckPlan {
	if (paths === null) {
		return {
			runTypecheck: false,
			runMigrationsCheck: false,
			runUnitTests: true,
			summary: 'pre-push: running test:push (could not list pushed paths)',
		}
	}
	if (paths.every(isDocsOnlyHookPath)) {
		return {
			runTypecheck: false,
			runMigrationsCheck: false,
			runUnitTests: false,
			summary: `pre-push: skipping test:push (${docsOnlySummary(paths)})`,
		}
	}
	return {
		runTypecheck: false,
		runMigrationsCheck: false,
		runUnitTests: true,
		summary: `pre-push: running test:push (${codePathSummary(paths)})`,
	}
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

function runNpmScript(script: string) {
	const result = spawnSync(resolveNpmCommand(), ['run', script], {
		stdio: 'inherit',
	})
	if (result.error) {
		console.error(result.error.message)
		return 1
	}
	return result.status ?? 1
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
