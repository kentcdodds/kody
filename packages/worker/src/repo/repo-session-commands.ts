import {
	type RepoSessionCheckRun,
	type RepoSessionInfoResult,
	type RepoSessionPublishResult,
} from './types.ts'

export type RepoGitCommand =
	| { kind: 'apply'; line: number; raw: string; patch: string }
	| { kind: 'status'; line: number; raw: string }
	| { kind: 'diff'; line: number; raw: string }
	| { kind: 'add'; line: number; raw: string; filepath: string }
	| { kind: 'rm'; line: number; raw: string; filepath: string }
	| { kind: 'commit'; line: number; raw: string; message: string }
	| { kind: 'log'; line: number; raw: string; depth?: number }
	| {
			kind: 'branch'
			line: number
			raw: string
			name?: string
			delete?: string
	  }
	| {
			kind: 'checkout'
			line: number
			raw: string
			ref?: string
			branch?: string
			force?: boolean
	  }
	| { kind: 'fetch'; line: number; raw: string; remote?: string; ref?: string }
	| { kind: 'pull'; line: number; raw: string; remote?: string; ref?: string }
	| {
			kind: 'push'
			line: number
			raw: string
			remote?: string
			ref?: string
			force?: boolean
	  }
	| {
			kind: 'remote'
			line: number
			raw: string
			action: 'list' | 'add' | 'remove'
			name?: string
			url?: string
	  }

export type RepoCommandResult = {
	line: number
	command: string
	ok: true
	output: unknown
}

export type RepoRunCommandsResult = {
	session: RepoSessionInfoResult
	commands: Array<RepoCommandResult>
	checks:
		| { status: 'not_requested' }
		| ({
				status: 'passed'
				ok: true
		  } & RepoSessionCheckRun)
		| ({
				status: 'failed'
				ok: false
				failedChecks: RepoSessionCheckRun['results']
		  } & RepoSessionCheckRun)
	publish:
		| { status: 'not_requested' }
		| {
				status: 'blocked_by_checks'
				message: string
				failedChecks?: RepoSessionCheckRun['results']
				runId?: string
				treeHash?: string
				checkedAt?: string
		  }
		| RepoSessionPublishResult
}

const supportedExamples = [
	'git status',
	'git diff',
	"git apply <<'PATCH' ... PATCH",
	'git add .',
	'git commit -m "message"',
	'git push origin main',
].join(', ')

export class RepoCommandParseError extends Error {
	constructor(input: { line: number; command: string; reason: string }) {
		super(
			`Unable to parse repo command on line ${input.line}: ${input.reason}\n` +
				`Command: ${JSON.stringify(input.command)}\n` +
				`Supported examples: ${supportedExamples}.`,
		)
		this.name = 'RepoCommandParseError'
	}
}

export function parseRepoGitCommands(commands: string) {
	const lines = commands.replace(/\r\n?/g, '\n').split('\n')
	const parsed: Array<RepoGitCommand> = []
	for (let index = 0; index < lines.length; index += 1) {
		const lineNumber = index + 1
		const raw = lines[index] ?? ''
		const trimmed = raw.trim()
		if (!trimmed || trimmed.startsWith('#')) continue
		const heredoc = trimmed.match(/^git\s+apply\s+<<(['"]?)([A-Za-z0-9_-]+)\1$/)
		if (heredoc) {
			const delimiter = heredoc[2]
			const patchLines: Array<string> = []
			let foundDelimiter = false
			for (index += 1; index < lines.length; index += 1) {
				const patchLine = lines[index] ?? ''
				if (patchLine.trim() === delimiter) {
					foundDelimiter = true
					break
				}
				patchLines.push(patchLine)
			}
			if (!foundDelimiter) {
				throw new RepoCommandParseError({
					line: lineNumber,
					command: raw,
					reason: `git apply heredoc is missing closing delimiter "${delimiter}".`,
				})
			}
			parsed.push({
				kind: 'apply',
				line: lineNumber,
				raw,
				patch: patchLines.join('\n'),
			})
			continue
		}
		parsed.push(parseSingleGitCommand(raw, lineNumber))
	}
	if (parsed.length === 0) {
		throw new RepoCommandParseError({
			line: 1,
			command: commands,
			reason: 'provide at least one git command.',
		})
	}
	return parsed
}

function parseSingleGitCommand(raw: string, line: number): RepoGitCommand {
	const tokens = tokenizeCommand(raw, line)
	if (tokens[0] !== 'git') {
		throw new RepoCommandParseError({
			line,
			command: raw,
			reason: 'commands must start with "git".',
		})
	}
	const subcommand = tokens[1]
	const args = tokens.slice(2)
	switch (subcommand) {
		case 'status':
			requireOnlyAllowedArgs(raw, line, args, ['--short'])
			return { kind: 'status', line, raw }
		case 'diff':
			requireNoArgs(raw, line, args)
			return { kind: 'diff', line, raw }
		case 'apply':
			throw new RepoCommandParseError({
				line,
				command: raw,
				reason:
					"git apply requires heredoc form, for example git apply <<'PATCH'.",
			})
		case 'add':
			return { kind: 'add', line, raw, filepath: parseOnePath(raw, line, args) }
		case 'rm':
			return { kind: 'rm', line, raw, filepath: parseOnePath(raw, line, args) }
		case 'commit':
			return {
				kind: 'commit',
				line,
				raw,
				message: parseCommitMessage(raw, line, args),
			}
		case 'log':
			return {
				kind: 'log',
				line,
				raw,
				depth: parseOptionalDepth(raw, line, args),
			}
		case 'branch':
			return parseBranch(raw, line, args)
		case 'checkout':
			return parseCheckout(raw, line, args)
		case 'fetch':
			return parseRemoteRefCommand('fetch', raw, line, args)
		case 'pull':
			return parseRemoteRefCommand('pull', raw, line, args)
		case 'push':
			return parsePush(raw, line, args)
		case 'remote':
			return parseRemote(raw, line, args)
		case undefined:
			throw new RepoCommandParseError({
				line,
				command: raw,
				reason: 'missing git subcommand.',
			})
		case 'clone':
			throw new RepoCommandParseError({
				line,
				command: raw,
				reason:
					'git clone is not supported because repo sessions are already cloned.',
			})
		default:
			throw new RepoCommandParseError({
				line,
				command: raw,
				reason: `unsupported git subcommand "${subcommand}".`,
			})
	}
}

function tokenizeCommand(raw: string, line: number) {
	const tokens: Array<string> = []
	let current = ''
	let quote: '"' | "'" | null = null
	let escaping = false
	for (const char of raw.trim()) {
		if (escaping) {
			current += char
			escaping = false
			continue
		}
		if (char === '\\' && quote !== "'") {
			escaping = true
			continue
		}
		if ((char === '"' || char === "'") && quote === null) {
			quote = char
			continue
		}
		if (char === quote) {
			quote = null
			continue
		}
		if (/\s/.test(char) && quote === null) {
			if (current) tokens.push(current)
			current = ''
			continue
		}
		current += char
	}
	if (escaping) current += '\\'
	if (quote !== null) {
		throw new RepoCommandParseError({
			line,
			command: raw,
			reason: `unterminated ${quote} quote.`,
		})
	}
	if (current) tokens.push(current)
	return tokens
}

function requireNoArgs(raw: string, line: number, args: Array<string>) {
	if (args.length > 0) {
		throw new RepoCommandParseError({
			line,
			command: raw,
			reason: `unexpected argument "${args[0]}".`,
		})
	}
}

function requireOnlyAllowedArgs(
	raw: string,
	line: number,
	args: Array<string>,
	allowed: Array<string>,
) {
	for (const arg of args) {
		if (!allowed.includes(arg)) {
			throw new RepoCommandParseError({
				line,
				command: raw,
				reason: `unexpected argument "${arg}".`,
			})
		}
	}
}

function parseOnePath(raw: string, line: number, args: Array<string>) {
	if (args.length !== 1) {
		throw new RepoCommandParseError({
			line,
			command: raw,
			reason: 'expected exactly one path argument.',
		})
	}
	return args[0] ?? ''
}

function parseCommitMessage(raw: string, line: number, args: Array<string>) {
	if (args.length !== 2 || (args[0] !== '-m' && args[0] !== '--message')) {
		throw new RepoCommandParseError({
			line,
			command: raw,
			reason: 'git commit requires -m "message".',
		})
	}
	const message = args[1] ?? ''
	if (!message.trim()) {
		throw new RepoCommandParseError({
			line,
			command: raw,
			reason: 'commit message cannot be empty.',
		})
	}
	return message
}

function parseOptionalDepth(raw: string, line: number, args: Array<string>) {
	if (args.length === 0) return undefined
	if (args.length !== 2 || args[0] !== '--depth') {
		throw new RepoCommandParseError({
			line,
			command: raw,
			reason: 'git log only supports optional --depth N.',
		})
	}
	const depth = Number.parseInt(args[1] ?? '', 10)
	if (!Number.isInteger(depth) || depth < 1) {
		throw new RepoCommandParseError({
			line,
			command: raw,
			reason: 'git log --depth requires a positive integer.',
		})
	}
	return depth
}

function parseBranch(
	raw: string,
	line: number,
	args: Array<string>,
): RepoGitCommand {
	if (args.length === 0) return { kind: 'branch', line, raw }
	if (args.length === 1) return { kind: 'branch', line, raw, name: args[0] }
	if (args.length === 2 && (args[0] === '-d' || args[0] === '--delete')) {
		return { kind: 'branch', line, raw, delete: args[1] }
	}
	throw new RepoCommandParseError({
		line,
		command: raw,
		reason: 'git branch supports no args, a branch name, or -d branch-name.',
	})
}

function parseCheckout(
	raw: string,
	line: number,
	args: Array<string>,
): RepoGitCommand {
	let force = false
	const remaining = args.filter((arg) => {
		if (arg === '--force' || arg === '-f') {
			force = true
			return false
		}
		return true
	})
	if (remaining.length === 1) {
		return { kind: 'checkout', line, raw, ref: remaining[0], force }
	}
	if (remaining.length === 2 && remaining[0] === '-b') {
		return { kind: 'checkout', line, raw, branch: remaining[1], force }
	}
	throw new RepoCommandParseError({
		line,
		command: raw,
		reason:
			'git checkout supports a ref, or -b branch-name, with optional --force.',
	})
}

function parseRemoteRefCommand(
	kind: 'fetch' | 'pull',
	raw: string,
	line: number,
	args: Array<string>,
): RepoGitCommand {
	if (args.length > 2) {
		throw new RepoCommandParseError({
			line,
			command: raw,
			reason: `git ${kind} supports optional remote and ref arguments only.`,
		})
	}
	return { kind, line, raw, remote: args[0], ref: args[1] }
}

function parsePush(
	raw: string,
	line: number,
	args: Array<string>,
): RepoGitCommand {
	let force = false
	const remaining = args.filter((arg) => {
		if (arg === '--force' || arg === '-f') {
			force = true
			return false
		}
		return true
	})
	if (remaining.length > 2) {
		throw new RepoCommandParseError({
			line,
			command: raw,
			reason:
				'git push supports optional remote and ref arguments plus optional --force.',
		})
	}
	return {
		kind: 'push',
		line,
		raw,
		remote: remaining[0],
		ref: remaining[1],
		force,
	}
}

function parseRemote(
	raw: string,
	line: number,
	args: Array<string>,
): RepoGitCommand {
	if (args.length === 0 || (args.length === 1 && args[0] === '-v')) {
		return { kind: 'remote', line, raw, action: 'list' }
	}
	if (args.length === 3 && args[0] === 'add') {
		return {
			kind: 'remote',
			line,
			raw,
			action: 'add',
			name: args[1],
			url: args[2],
		}
	}
	if (args.length === 2 && (args[0] === 'remove' || args[0] === 'rm')) {
		return { kind: 'remote', line, raw, action: 'remove', name: args[1] }
	}
	throw new RepoCommandParseError({
		line,
		command: raw,
		reason: 'git remote supports list, -v, add name url, or remove name.',
	})
}
