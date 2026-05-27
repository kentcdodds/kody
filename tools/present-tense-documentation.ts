import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export type PresentTenseViolation = {
	file: string
	line: number
	pattern: string
	text: string
}

const excludedRelativeFiles = new Set([
	'docs/contributing/documentation.md',
	'docs/contributing/secret-rotation.md',
])

const bannedPatterns: Array<{ name: string; pattern: RegExp }> = [
	{ name: 'now we', pattern: /\bnow we\b/i },
	{ name: 'we now', pattern: /\bwe now\b/i },
	{ name: 'we no longer', pattern: /\bwe no longer\b/i },
	{
		name: 'no longer (support|accept|use|require)',
		pattern: /\bno longer (support|accept|use|require)/i,
	},
	{ name: 'Kody now', pattern: /\bKody now\b/i },
	{ name: 'previously we', pattern: /\bpreviously we\b/i },
	{
		name: 'previously (supported|used|accepted)',
		pattern: /\bpreviously (supported|used|accepted)\b/i,
	},
	{ name: 'formerly', pattern: /\bformerly\b/i },
	{
		name: 'recently added',
		pattern: /\brecently added\b/i,
	},
	{
		name: 'newly added',
		pattern: /\bnewly added\b/i,
	},
]

const markdownRoots = ['docs', '.agents'] as const

const extraRelativeFiles = [
	'README.md',
	'AGENTS.md',
	'packages/worker/src/mcp/server-instructions.ts',
] as const

const clientUiRoots = ['packages/worker/client'] as const

async function collectMarkdownFiles(
	repoRoot: string,
	directory: string,
): Promise<Array<string>> {
	const absoluteDirectory = path.join(repoRoot, directory)
	const entries = await readdir(absoluteDirectory, { withFileTypes: true })
	const files: Array<string> = []

	for (const entry of entries) {
		const relativePath = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await collectMarkdownFiles(repoRoot, relativePath)))
			continue
		}
		if (entry.name.endsWith('.md')) {
			files.push(relativePath)
		}
	}

	return files
}

async function collectClientUiFiles(
	repoRoot: string,
	directory: string,
): Promise<Array<string>> {
	const absoluteDirectory = path.join(repoRoot, directory)
	const entries = await readdir(absoluteDirectory, { withFileTypes: true })
	const files: Array<string> = []

	for (const entry of entries) {
		const relativePath = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await collectClientUiFiles(repoRoot, relativePath)))
			continue
		}
		if (entry.name.endsWith('.tsx')) {
			files.push(relativePath)
		}
	}

	return files
}

function* linesOutsideMarkdownCodeFences(
	content: string,
): Generator<{ line: number; text: string }> {
	let inFence = false
	const lines = content.split('\n')

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? ''
		if (line.trim().startsWith('```')) {
			inFence = !inFence
			continue
		}
		if (!inFence) {
			yield { line: index + 1, text: line }
		}
	}
}

function findViolationsInLine(input: {
	file: string
	line: number
	text: string
}): Array<PresentTenseViolation> {
	const violations: Array<PresentTenseViolation> = []

	for (const banned of bannedPatterns) {
		if (!banned.pattern.test(input.text)) continue
		violations.push({
			file: input.file,
			line: input.line,
			pattern: banned.name,
			text: input.text.trim(),
		})
	}

	return violations
}

function scanPlainTextFile(input: {
	relativePath: string
	content: string
}): Array<PresentTenseViolation> {
	const violations: Array<PresentTenseViolation> = []
	const lines = input.relativePath.endsWith('.md')
		? linesOutsideMarkdownCodeFences(input.content)
		: input.content.split('\n').map((text, index) => ({
				line: index + 1,
				text,
			}))

	for (const line of lines) {
		violations.push(
			...findViolationsInLine({
				file: input.relativePath,
				line: line.line,
				text: line.text,
			}),
		)
	}

	return violations
}

export async function findPresentTenseDocumentationViolations(
	repoRoot = process.cwd(),
): Promise<Array<PresentTenseViolation>> {
	const relativeFiles = new Set<string>([
		...extraRelativeFiles,
		...(
			await Promise.all(
				markdownRoots.map((root) => collectMarkdownFiles(repoRoot, root)),
			)
		).flat(),
		...(
			await Promise.all(
				clientUiRoots.map((root) => collectClientUiFiles(repoRoot, root)),
			)
		).flat(),
	])

	const violations: Array<PresentTenseViolation> = []

	for (const relativePath of [...relativeFiles].sort()) {
		if (excludedRelativeFiles.has(relativePath)) continue

		const content = await readFile(path.join(repoRoot, relativePath), 'utf8')
		violations.push(
			...scanPlainTextFile({
				relativePath,
				content,
			}),
		)
	}

	return violations.sort((left, right) => {
		const fileOrder = left.file.localeCompare(right.file)
		if (fileOrder !== 0) return fileOrder
		return left.line - right.line
	})
}

export function formatPresentTenseViolations(
	violations: ReadonlyArray<PresentTenseViolation>,
) {
	return violations
		.map(
			(violation) =>
				`${violation.file}:${violation.line} (${violation.pattern}) ${violation.text}`,
		)
		.join('\n')
}

async function main() {
	const violations = await findPresentTenseDocumentationViolations()
	if (violations.length === 0) {
		console.log('No present-tense documentation violations found.')
		return
	}

	console.error(
		'Present-tense documentation violations found:\n' +
			formatPresentTenseViolations(violations),
	)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	void main()
}
