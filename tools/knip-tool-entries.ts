import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Knip entries under tools/. Shared helpers stay project files so unused
 * exports are reported. A file is an entry only when it is a CLI main:
 * `isExecutedDirectly(import.meta.url)` in code, an argv main, a node shebang,
 * or an esbuild `*.entry.ts` bundle target. Comments do not count. package.json,
 * project.json, husky, and GitHub Actions `run` scripts are left to Knip's own
 * plugins so the same file is not listed twice.
 */

const toolExtensions = new Set(['.ts', '.js', '.mjs'])

const skipDirectories = new Set([
	'.git',
	'.wrangler',
	'build',
	'coverage',
	'dist',
	'node_modules',
])

const directExecution =
	/isExecutedDirectly\(\s*import\.meta\.url\s*\)|import\.meta\.url\s*===\s*pathToFileURL\(\s*process\.argv\[1\]\s*\)\.href|pathToFileURL\(\s*process\.argv\[1\]\s*\)\.href\s*===\s*import\.meta\.url/

const nodeToolInvocation =
	/(?:^|[^\w./-])node(?:\s+(?:--[\w][\w.-]*(?:=[^\s"'`]+)?|-[A-Za-z]+))*\s+(?:\.\.?\/)?(tools\/(?:[\w.-]+\/)*[\w.-]+\.(?:ts|js|mjs))/g

const bundleEntryPath = /['"](tools\/(?:[\w.-]+\/)*[\w.-]+\.entry\.ts)['"]/g

export function toolCliEntryFiles(repoRoot: string): Array<string> {
	const pluginOwned = pluginOwnedToolPaths(repoRoot)
	const entries = new Set<string>(extraToolPaths(repoRoot))
	for (const relativePath of toolSourceFiles(repoRoot)) {
		if (pluginOwned.has(relativePath)) continue
		const source = readFileSync(path.join(repoRoot, relativePath), 'utf8')
		if (isCliSource(source)) entries.add(relativePath)
	}
	for (const relativePath of pluginOwned) entries.delete(relativePath)
	return [...entries].sort()
}

function isCliSource(source: string) {
	if (hasNodeShebang(source)) return true
	return directExecution.test(stripComments(source))
}

function stripComments(source: string) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function hasNodeShebang(source: string) {
	if (!source.startsWith('#!')) return false
	const lineEnd = source.indexOf('\n')
	const shebang = lineEnd === -1 ? source : source.slice(0, lineEnd)
	return shebang.includes('node')
}

function pluginOwnedToolPaths(repoRoot: string) {
	const invoked = new Set<string>()
	for (const filePath of invocationSourceFiles(repoRoot)) {
		const relativePath = toPosix(path.relative(repoRoot, filePath))
		if (!isPluginOwnedSource(relativePath)) continue
		const source = readFileSync(filePath, 'utf8')
		const scanText = isGithubWorkflowSource(relativePath)
			? stripQuotedShellStrings(githubWorkflowRunScripts(source))
			: source
		collectToolPaths(invoked, scanText, nodeToolInvocation)
	}
	return invoked
}

/**
 * Knip's GitHub Actions plugin only treats `step.run` values as scripts, and
 * its bash parser does not treat `node tools/…` inside `echo` / description
 * strings as invocations. Mirror that so prose cannot mark a CLI as
 * plugin-owned.
 */
function stripQuotedShellStrings(source: string) {
	return source
		.replace(/"(?:\\.|[^"\\])*"/g, '""')
		.replace(/'(?:\\.|[^'\\])*'/g, "''")
		.replace(/`(?:\\.|[^`\\])*`/g, '``')
}

function githubWorkflowRunScripts(source: string) {
	const scripts: Array<string> = []
	const lines = source.split('\n')
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]
		if (line === undefined) continue
		const match = /^(?<indent>\s*)run:\s*(?<rest>.*)$/.exec(line)
		const groups = match?.groups
		const indentText = groups?.indent
		const restText = groups?.rest
		if (indentText === undefined || restText === undefined) continue
		const indent = indentText.length
		const trimmed = restText.trimEnd().trim()
		if (trimmed === '' || trimmed.startsWith('|') || trimmed.startsWith('>')) {
			const block: Array<string> = []
			index += 1
			while (index < lines.length) {
				const blockLine = lines[index]
				if (blockLine === undefined) break
				if (blockLine.trim() === '') {
					block.push(blockLine)
					index += 1
					continue
				}
				const leading = /^\s*/.exec(blockLine)?.[0].length ?? 0
				if (leading <= indent) {
					index -= 1
					break
				}
				block.push(blockLine)
				index += 1
			}
			scripts.push(block.join('\n'))
			continue
		}
		scripts.push(unquoteScalar(trimmed))
	}
	return scripts.join('\n')
}

function unquoteScalar(value: string) {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1)
	}
	return value
}

function isGithubWorkflowSource(relativePath: string) {
	const name = path.posix.basename(relativePath)
	return (
		relativePath.startsWith('.github/') &&
		(name.endsWith('.yml') || name.endsWith('.yaml'))
	)
}

function extraToolPaths(repoRoot: string) {
	const invoked = new Set<string>()
	for (const relativePath of toolSourceFiles(repoRoot)) {
		collectToolPaths(
			invoked,
			readFileSync(path.join(repoRoot, relativePath), 'utf8'),
			bundleEntryPath,
		)
	}
	return invoked
}

function isPluginOwnedSource(relativePath: string) {
	const name = path.posix.basename(relativePath)
	return (
		name === 'package.json' ||
		name === 'project.json' ||
		(relativePath.startsWith('.github/') &&
			(name.endsWith('.yml') || name.endsWith('.yaml'))) ||
		(relativePath.startsWith('.husky/') &&
			!relativePath.startsWith('.husky/_/'))
	)
}

function collectToolPaths(invoked: Set<string>, text: string, pattern: RegExp) {
	for (const match of text.matchAll(pattern)) {
		const relativePath = match[1]
		if (relativePath) invoked.add(relativePath)
	}
}

function invocationSourceFiles(repoRoot: string) {
	const files: Array<string> = []
	walk(repoRoot, '', (absolutePath, relativePath, isDirectory) => {
		if (isDirectory) return
		const name = path.posix.basename(relativePath)
		if (name === 'package.json' || name === 'project.json') {
			files.push(absolutePath)
			return
		}
		if (
			relativePath.startsWith('.github/') &&
			(name.endsWith('.yml') || name.endsWith('.yaml'))
		) {
			files.push(absolutePath)
			return
		}
		if (
			relativePath.startsWith('.husky/') &&
			!relativePath.startsWith('.husky/_/')
		) {
			files.push(absolutePath)
		}
	})
	return files
}

function toolSourceFiles(repoRoot: string) {
	const files: Array<string> = []
	const toolsRoot = path.join(repoRoot, 'tools')
	walk(toolsRoot, 'tools', (_absolutePath, relativePath, isDirectory) => {
		if (isDirectory || !isToolSource(relativePath)) return
		files.push(relativePath)
	})
	return files
}

function isToolSource(relativePath: string) {
	if (relativePath.endsWith('.d.ts')) return false
	if (/\.(?:node\.)?test\.ts$/.test(relativePath)) return false
	if (relativePath.endsWith('.spec.ts')) return false
	return toolExtensions.has(path.posix.extname(relativePath))
}

function walk(
	directory: string,
	relativeDirectory: string,
	visit: (
		absolutePath: string,
		relativePath: string,
		isDirectory: boolean,
	) => void,
) {
	let names: Array<string>
	try {
		names = readdirSync(directory)
	} catch {
		return
	}
	for (const name of names) {
		if (skipDirectories.has(name)) continue
		const absolutePath = path.join(directory, name)
		const relativePath = toPosix(
			relativeDirectory ? path.join(relativeDirectory, name) : name,
		)
		let isDirectory = false
		try {
			isDirectory = statSync(absolutePath).isDirectory()
		} catch {
			continue
		}
		if (isDirectory) {
			if (name.startsWith('.') && name !== '.github' && name !== '.husky') {
				continue
			}
			if (relativePath === '.husky/_') continue
			visit(absolutePath, relativePath, true)
			walk(absolutePath, relativePath, visit)
			continue
		}
		visit(absolutePath, relativePath, false)
	}
}

function toPosix(filePath: string) {
	return filePath.split(path.sep).join('/')
}
