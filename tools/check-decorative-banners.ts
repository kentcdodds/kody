import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export type DecorativeBannerMatch = {
	file: string
	line: number
	excerpt: string
}

const scannedRelativeRoots = [
	path.join('packages', 'worker', 'client'),
	path.join('packages', 'worker', 'universal', 'styles'),
]

const scannedFilePattern = /\.(?:ts|tsx|js|jsx|css)$/

const skipDirectoryNames = new Set([
	'.git',
	'.wrangler',
	'build',
	'dist',
	'node_modules',
])

/**
 * Decorative section banners: a run of five or more `=` or `-` inside a
 * block comment. Load-bearing layout comments stay; they just cannot use
 * this banner shape.
 */
export const decorativeBannerPattern = /^\s*(?:\{\s*)?\/\*.*(={5,}|-{5,})/

export function findDecorativeBannerMatches(input: {
	relativePath: string
	content: string
}): Array<DecorativeBannerMatch> {
	const matches: Array<DecorativeBannerMatch> = []
	const lines = input.content.split('\n')
	for (const [index, line] of lines.entries()) {
		if (!decorativeBannerPattern.test(line)) continue
		matches.push({
			file: input.relativePath,
			line: index + 1,
			excerpt: line.trim(),
		})
	}
	return matches
}

async function collectScannedFiles(
	cwd: string,
	relativeRoot: string,
): Promise<Array<string>> {
	const matches: Array<string> = []
	const root = path.join(cwd, relativeRoot)
	const stack = [root]
	while (stack.length > 0) {
		const current = stack.pop()
		if (!current) continue
		let entries
		try {
			entries = await readdir(current, { withFileTypes: true })
		} catch (error) {
			if (
				error instanceof Error &&
				'code' in error &&
				error.code === 'ENOENT'
			) {
				continue
			}
			throw error
		}
		for (const entry of entries) {
			const absolutePath = path.join(current, entry.name)
			if (entry.isDirectory()) {
				if (skipDirectoryNames.has(entry.name)) continue
				stack.push(absolutePath)
				continue
			}
			if (!entry.isFile() || !scannedFilePattern.test(entry.name)) continue
			matches.push(path.relative(cwd, absolutePath).replaceAll('\\', '/'))
		}
	}
	return matches
}

export async function listDecorativeBannerPaths(
	cwd: string = process.cwd(),
): Promise<Array<string>> {
	const paths: Array<string> = []
	for (const relativeRoot of scannedRelativeRoots) {
		paths.push(...(await collectScannedFiles(cwd, relativeRoot)))
	}
	return [...new Set(paths)].sort()
}

export async function checkDecorativeBanners(
	cwd: string = process.cwd(),
): Promise<Array<DecorativeBannerMatch>> {
	const matches: Array<DecorativeBannerMatch> = []
	for (const relativePath of await listDecorativeBannerPaths(cwd)) {
		matches.push(
			...findDecorativeBannerMatches({
				relativePath,
				content: await readFile(path.join(cwd, relativePath), 'utf8'),
			}),
		)
	}
	return matches
}

function formatMatches(matches: ReadonlyArray<DecorativeBannerMatch>) {
	return matches
		.map((match) => `${match.file}:${String(match.line)}: ${match.excerpt}`)
		.join('\n')
}

export async function main(cwd: string = process.cwd()): Promise<void> {
	const matches = await checkDecorativeBanners(cwd)
	if (matches.length === 0) {
		console.log('Decorative-banner check passed.')
		return
	}
	console.error(
		[
			`Decorative-banner check failed (${String(matches.length)} issue(s)).`,
			'Do not mark sections with `========` or `----------` comment banners.',
			'',
			formatMatches(matches),
		].join('\n'),
	)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
