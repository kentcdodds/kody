import { spawnSync } from 'node:child_process'
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export const huskyUserHookNames = [
	'pre-push',
	'pre-commit',
	'commit-msg',
] as const

export type HuskyUserHookName = (typeof huskyUserHookNames)[number]

export type GitHooksPathConfig = {
	get: () => string | null
	set: (hooksPath: string) => void
}

export type EnsureCloudAgentHooksInput = {
	repoRoot: string
	homeDir: string
	gitHooksPath: GitHooksPathConfig
}

export type EnsureCloudAgentHooksResult =
	| { status: 'skipped'; reason: 'no-agent-hooks' }
	| {
			status: 'composed'
			agentHooksDir: string
			originalHooksPath: string
			restoredHooksPath: boolean
			linkedHookNames: Array<HuskyUserHookName>
	  }

export function huskyHandlerDir(repoRoot: string) {
	return resolve(repoRoot, '.husky', '_')
}

export function findAgentHooksDir(agentHooksRoot: string) {
	if (!existsSync(agentHooksRoot)) return null
	const entries = readdirSync(agentHooksRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right))
	for (const name of entries) {
		const dir = join(agentHooksRoot, name)
		if (existsSync(join(dir, '.dispatcher'))) return dir
	}
	return null
}

export function readGitHooksPath(cwd: string) {
	const result = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
		cwd,
		encoding: 'utf8',
	})
	if (result.status !== 0) return null
	const value = result.stdout.trim()
	return value.length > 0 ? value : null
}

export function writeGitHooksPath(cwd: string, hooksPath: string) {
	const result = spawnSync('git', ['config', 'core.hooksPath', hooksPath], {
		cwd,
		encoding: 'utf8',
	})
	if (result.status !== 0) {
		throw new Error(
			`Failed to set core.hooksPath to ${hooksPath}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`,
		)
	}
}

function isDispatcherSymlink(path: string) {
	try {
		return (
			lstatSync(path).isSymbolicLink() && readlinkSync(path) === '.dispatcher'
		)
	} catch {
		return false
	}
}

function ensureDispatcherSymlink(agentHooksDir: string, hookName: string) {
	const target = join(agentHooksDir, hookName)
	if (isDispatcherSymlink(target)) return false
	if (existsSync(target) || isSymlink(target)) {
		unlinkSync(target)
	}
	symlinkSync('.dispatcher', target)
	return true
}

function isSymlink(path: string) {
	try {
		return lstatSync(path).isSymbolicLink()
	} catch {
		return false
	}
}

function linkedHuskyHookNames(repoRoot: string, agentHooksDir: string) {
	const linked: Array<HuskyUserHookName> = []
	for (const hookName of huskyUserHookNames) {
		if (!existsSync(join(repoRoot, '.husky', hookName))) continue
		ensureDispatcherSymlink(agentHooksDir, hookName)
		linked.push(hookName)
	}
	return linked
}

export function ensureCloudAgentHooks(
	input: EnsureCloudAgentHooksInput,
): EnsureCloudAgentHooksResult {
	const agentHooksDir = findAgentHooksDir(
		join(input.homeDir, '.cursor', 'agent-hooks'),
	)
	if (!agentHooksDir) {
		return { status: 'skipped', reason: 'no-agent-hooks' }
	}

	const originalHooksPath = huskyHandlerDir(input.repoRoot)
	if (!existsSync(originalHooksPath)) {
		throw new Error(
			`Husky handler directory is missing: ${originalHooksPath}. Run husky before ensure-cloud-agent-hooks.`,
		)
	}

	const currentHooksPath = input.gitHooksPath.get()
	const restoredHooksPath = currentHooksPath !== agentHooksDir
	if (restoredHooksPath) {
		input.gitHooksPath.set(agentHooksDir)
	}

	const originalPathFile = join(agentHooksDir, '.cursor-original-hooks-path')
	const currentOriginal = existsSync(originalPathFile)
		? readFileSync(originalPathFile, 'utf8').trim()
		: ''
	if (currentOriginal !== originalHooksPath) {
		writeFileSync(originalPathFile, `${originalHooksPath}\n`)
	}

	return {
		status: 'composed',
		agentHooksDir,
		originalHooksPath,
		restoredHooksPath,
		linkedHookNames: linkedHuskyHookNames(input.repoRoot, agentHooksDir),
	}
}

function formatResult(result: EnsureCloudAgentHooksResult) {
	switch (result.status) {
		case 'skipped':
			return 'ensure-cloud-agent-hooks: skipped (no Cursor agent-hooks dispatcher)'
		case 'composed':
			return [
				'ensure-cloud-agent-hooks: composed Cursor dispatcher with Husky',
				`  agentHooksDir=${result.agentHooksDir}`,
				`  originalHooksPath=${result.originalHooksPath}`,
				`  restoredHooksPath=${result.restoredHooksPath}`,
				`  linked=${result.linkedHookNames.join(',') || '(none)'}`,
			].join('\n')
		default: {
			const exhaustive: never = result
			throw new Error(
				`Unhandled ensure-cloud-agent-hooks result: ${exhaustive}`,
			)
		}
	}
}

export function main() {
	const repoRoot = process.cwd()
	const result = ensureCloudAgentHooks({
		repoRoot,
		homeDir: homedir(),
		gitHooksPath: {
			get: () => readGitHooksPath(repoRoot),
			set: (hooksPath) => {
				writeGitHooksPath(repoRoot, hooksPath)
			},
		},
	})
	if (result.status === 'composed') {
		console.log(formatResult(result))
	}
}

if (isExecutedDirectly(import.meta.url)) {
	main()
}
