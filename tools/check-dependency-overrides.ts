import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export const defaultPackageJsonPath = 'package.json'
export const defaultOverridesDocPath = path.join(
	'docs',
	'contributing',
	'dependency-overrides.md',
)

export type OverrideTarget = {
	packageName: string
	parents: Array<string>
}

export type OverrideDocHeading = {
	line: number
	codeSpans: Array<string>
}

export type DependencyOverridesCheckResult = {
	ok: boolean
	errors: Array<string>
}

type JsonFrame =
	| { kind: 'object'; path: string; keys: Set<string>; lastKey?: string }
	| { kind: 'array'; path: string }

function childPath(parent: JsonFrame | undefined): string {
	if (!parent) return ''
	if (parent.kind === 'array') return `${parent.path}[]`
	const key = parent.lastKey ?? ''
	return parent.path ? `${parent.path}.${key}` : key
}

function findStringEnd(source: string, start: number): number {
	for (let index = start + 1; index < source.length; index++) {
		if (source[index] === '\\') {
			index++
			continue
		}
		if (source[index] === '"') return index
	}
	return source.length - 1
}

/**
 * `JSON.parse` silently keeps the last value for a repeated key, so a
 * duplicated override looks applied in review while only one entry wins.
 */
export function findDuplicateJsonKeys(source: string): Array<string> {
	const duplicates: Array<string> = []
	const stack: Array<JsonFrame> = []
	let expectingKey = false
	for (let index = 0; index < source.length; index++) {
		const char = source[index]
		const top = stack.at(-1)
		if (char === '"') {
			const end = findStringEnd(source, index)
			if (top?.kind === 'object' && expectingKey) {
				const key = JSON.parse(source.slice(index, end + 1)) as string
				if (top.keys.has(key)) {
					duplicates.push(top.path ? `${top.path}.${key}` : key)
				}
				top.keys.add(key)
				top.lastKey = key
				expectingKey = false
			}
			index = end
		} else if (char === '{') {
			stack.push({ kind: 'object', path: childPath(top), keys: new Set() })
			expectingKey = true
		} else if (char === '[') {
			stack.push({ kind: 'array', path: childPath(top) })
			expectingKey = false
		} else if (char === '}' || char === ']') {
			stack.pop()
			expectingKey = false
		} else if (char === ',') {
			expectingKey = top?.kind === 'object'
		}
	}
	return duplicates
}

export function listOverrideTargets(
	overrides: Record<string, unknown>,
	parents: Array<string> = [],
): Array<OverrideTarget> {
	const targets: Array<OverrideTarget> = []
	for (const [key, value] of Object.entries(overrides)) {
		if (key === '.') {
			const packageName = parents.at(-1)
			if (packageName) {
				targets.push({ packageName, parents: parents.slice(0, -1) })
			}
		} else if (value && typeof value === 'object') {
			targets.push(
				...listOverrideTargets(value as Record<string, unknown>, [
					...parents,
					key,
				]),
			)
		} else {
			targets.push({ packageName: key, parents })
		}
	}
	return targets
}

export function parseOverrideDocHeadings(
	markdown: string,
): Array<OverrideDocHeading> {
	return markdown.split('\n').flatMap((text, index) => {
		if (!text.startsWith('### ')) return []
		const codeSpans = [...text.matchAll(/`([^`]+)`/g)].flatMap((match) =>
			match[1] ? [match[1]] : [],
		)
		return [{ line: index + 1, codeSpans }]
	})
}

function describeTarget(target: OverrideTarget): string {
	return [...target.parents, target.packageName].join(' > ')
}

export function findOverrideDocumentationErrors(input: {
	targets: ReadonlyArray<OverrideTarget>
	headings: ReadonlyArray<OverrideDocHeading>
	docPath?: string
}): Array<string> {
	const docPath = input.docPath ?? defaultOverridesDocPath
	const errors: Array<string> = []
	for (const target of input.targets) {
		const documented = input.headings.some(
			(heading) =>
				heading.codeSpans[0] === target.packageName &&
				target.parents.every((parent) => heading.codeSpans.includes(parent)),
		)
		if (!documented) {
			const parentHint =
				target.parents.length > 0
					? ` that also names ${target.parents.map((parent) => `\`${parent}\``).join(', ')}`
					: ''
			errors.push(
				`package.json override "${describeTarget(target)}" has no "### \`${target.packageName}\`" heading${parentHint} in ${docPath}. Document why it exists and when it can be removed.`,
			)
		}
	}
	const overriddenPackages = new Set(
		input.targets.map((target) => target.packageName),
	)
	for (const heading of input.headings) {
		const packageName = heading.codeSpans[0]
		if (packageName === undefined) {
			errors.push(
				`${docPath}:${heading.line} heading must start with the overridden package name in backticks.`,
			)
		} else if (!overriddenPackages.has(packageName)) {
			errors.push(
				`${docPath}:${heading.line} documents \`${packageName}\`, but package.json has no override for it. Remove the stale section.`,
			)
		}
	}
	return errors
}

export async function checkDependencyOverrides(
	cwd: string = process.cwd(),
	packageJsonPath: string = defaultPackageJsonPath,
	docPath: string = defaultOverridesDocPath,
): Promise<DependencyOverridesCheckResult> {
	const packageJsonSource = await readFile(
		path.join(cwd, packageJsonPath),
		'utf8',
	)
	const packageJson = JSON.parse(packageJsonSource) as {
		overrides?: Record<string, unknown>
	}
	const docSource = await readFile(path.join(cwd, docPath), 'utf8')
	const errors = [
		...findDuplicateJsonKeys(packageJsonSource).map(
			(key) =>
				`${packageJsonPath} repeats key "${key}"; JSON keeps only the last value, so the earlier entry is dead.`,
		),
		...findOverrideDocumentationErrors({
			targets: listOverrideTargets(packageJson.overrides ?? {}),
			headings: parseOverrideDocHeadings(docSource),
			docPath,
		}),
	]
	return { ok: errors.length === 0, errors }
}

if (isExecutedDirectly(import.meta.url)) {
	const result = await checkDependencyOverrides()
	for (const error of result.errors) {
		console.error(error)
	}
	if (!result.ok) {
		process.exitCode = 1
	}
}
