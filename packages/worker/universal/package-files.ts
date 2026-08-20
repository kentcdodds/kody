import { createMultiMatcher } from 'remix/route-pattern/match'
import { routes } from '#universal/routes.ts'

/**
 * Second-segment `/@username/…` namespaces claimed before the app router.
 * A package whose `kody.id` is one of these cannot use
 * `/@owner/:kodyId/files/…` because `/@owner/packages/files/…` is a hosted
 * package-app path. Fall back to `/community/:listingId/files/…`.
 */
export const reservedPackageFilesKodyIds = [
	'packages',
	'api',
	'webhooks',
	'connectors',
] as const

export type PackageFilesKind = 'file' | 'directory'

export type PackageFilesContentKind = 'markdown' | 'code' | 'text'

export type PackageFilesChild = {
	name: string
	path: string
	kind: PackageFilesKind
}

export type PackageFilesAncestor = {
	name: string
	path: string
}

export type PackageFilesView = {
	paths: Array<string>
	selectedPath: string
	kind: PackageFilesKind
	content: string | null
	contentPath: string | null
	contentKind: PackageFilesContentKind | null
	language: string | null
	children: Array<PackageFilesChild>
}

const readmeFileNamePattern = /^readme(?:\.[a-z0-9._-]+)?$/i
const preferredReadmeNames = [
	'readme.md',
	'readme.mdx',
	'readme.markdown',
	'readme.txt',
	'readme',
] as const

const extensionLanguages: Record<string, string> = {
	ts: 'ts',
	tsx: 'tsx',
	js: 'ts',
	jsx: 'tsx',
	mjs: 'ts',
	cjs: 'ts',
	json: 'json',
	md: 'markdown',
	markdown: 'markdown',
	mdx: 'markdown',
	yml: 'yaml',
	yaml: 'yaml',
	toml: 'toml',
	html: 'html',
	htm: 'html',
	css: 'css',
	sh: 'shellscript',
	bash: 'shellscript',
	zsh: 'shellscript',
	py: 'python',
	go: 'go',
	rs: 'rust',
	sql: 'sql',
	graphql: 'graphql',
	gql: 'graphql',
	xml: 'xml',
	svg: 'xml',
	dockerfile: 'dockerfile',
	env: 'dotenv',
	ini: 'ini',
	diff: 'diff',
	patch: 'diff',
}

// Shiki grammar ids are what the highlighter needs; these are what a reader
// should see next to a file's line count.
const languageLabels: Record<string, string> = {
	ts: 'TypeScript',
	tsx: 'TypeScript',
	json: 'JSON',
	markdown: 'Markdown',
	yaml: 'YAML',
	toml: 'TOML',
	html: 'HTML',
	css: 'CSS',
	shellscript: 'Shell',
	python: 'Python',
	go: 'Go',
	rust: 'Rust',
	sql: 'SQL',
	graphql: 'GraphQL',
	xml: 'XML',
	dockerfile: 'Dockerfile',
	dotenv: 'Dotenv',
	ini: 'INI',
	diff: 'Diff',
	plaintext: 'Plain text',
}

// The grammar map aliases the js family to the TypeScript grammar so the
// client bundles one grammar for both; the label must not leak that, so it
// derives from the file's own extension instead of the grammar id.
const javascriptExtensions = new Set(['js', 'jsx', 'mjs', 'cjs'])

export function packageFileLanguageLabel(path: string | null | undefined) {
	if (!path) return ''
	const name = path.split('/').pop() ?? ''
	const separator = name.lastIndexOf('.')
	const extension = separator > 0 ? name.slice(separator + 1).toLowerCase() : ''
	if (javascriptExtensions.has(extension)) return 'JavaScript'
	const language = languageFromFilePath(path)
	return languageLabels[language] ?? language
}

/**
 * The `/files` explorer routes, in every public shape. The app shell asks
 * this so it can leave the page unpadded: the explorer owns its gutters (like
 * the package listing it hangs off), and the shell's generic `main` padding
 * would stack on top and push the content in past the site header.
 */
const packageFilesPathMatcher = (() => {
	const matcher = createMultiMatcher<true>()
	matcher.add(routes.communityPackageFiles.pattern, true)
	matcher.add(routes.communityDetailFiles.pattern, true)
	matcher.add(routes.accountPackageFiles.pattern, true)
	return matcher
})()

export function isPackageFilesPathname(pathname: string) {
	return (
		packageFilesPathMatcher.match(new URL(pathname, 'http://localhost')) != null
	)
}

export function isReservedPackageFilesKodyId(kodyId: string) {
	return (reservedPackageFilesKodyIds as ReadonlyArray<string>).includes(
		kodyId.trim().toLowerCase(),
	)
}

/**
 * Normalize a URL path segment or query value to a repo-relative file path.
 * Empty string is the package root. Returns null for traversal or junk.
 */
export function normalizePackageFilesPath(
	raw: string | null | undefined,
): string | null {
	if (raw == null) return ''
	const trimmed = raw.trim()
	if (trimmed === '' || trimmed === '/') return ''
	if (trimmed.includes('\\') || trimmed.includes('\0')) return null
	let decoded = trimmed
	try {
		decoded = decodeURIComponent(trimmed)
	} catch {
		return null
	}
	if (decoded.includes('\\') || decoded.includes('\0')) return null
	const parts = decoded.split('/').filter((part) => part !== '' && part !== '.')
	if (parts.some((part) => part === '..')) return null
	return parts.join('/')
}

export function languageFromFilePath(path: string) {
	const name = path.split('/').pop() ?? ''
	if (name === 'Dockerfile' || name === 'dockerfile') return 'dockerfile'
	if (name === '.env' || name.startsWith('.env.')) return 'dotenv'
	const separator = name.lastIndexOf('.')
	if (separator <= 0) return 'plaintext'
	const ext = name.slice(separator + 1).toLowerCase()
	return extensionLanguages[ext] ?? 'plaintext'
}

export function contentKindFromLanguage(
	language: string,
): PackageFilesContentKind {
	if (language === 'markdown') return 'markdown'
	if (language === 'plaintext') return 'text'
	return 'code'
}

export function joinPackageFilesPath(basePath: string, relativePath: string) {
	if (!relativePath) return basePath
	return `${basePath}/${relativePath.split('/').map(encodeURIComponent).join('/')}`
}

export function buildPackageFilesAncestors(selectedPath: string) {
	if (!selectedPath) return []
	const parts = selectedPath.split('/')
	const ancestors: Array<PackageFilesAncestor> = []
	for (let index = 0; index < parts.length; index += 1) {
		const name = parts[index]
		if (!name) continue
		ancestors.push({
			name,
			path: parts.slice(0, index + 1).join('/'),
		})
	}
	return ancestors
}

function sortReadmeCandidates(paths: Array<string>) {
	return [...paths].sort((left, right) => {
		const normalizedLeft = left.split('/').pop()?.toLowerCase() ?? ''
		const normalizedRight = right.split('/').pop()?.toLowerCase() ?? ''
		const leftIndex = preferredReadmeNames.indexOf(
			normalizedLeft as (typeof preferredReadmeNames)[number],
		)
		const rightIndex = preferredReadmeNames.indexOf(
			normalizedRight as (typeof preferredReadmeNames)[number],
		)
		const leftRank = leftIndex === -1 ? preferredReadmeNames.length : leftIndex
		const rightRank =
			rightIndex === -1 ? preferredReadmeNames.length : rightIndex
		if (leftRank !== rightRank) return leftRank - rightRank
		return normalizedLeft.localeCompare(normalizedRight)
	})
}

export function findDirectoryReadmePath(
	files: Record<string, string>,
	directoryPath: string,
) {
	const prefix = directoryPath === '' ? '' : `${directoryPath}/`
	const matches = Object.keys(files).filter((path) => {
		if (!path.startsWith(prefix)) return false
		const rest = path.slice(prefix.length)
		return !rest.includes('/') && readmeFileNamePattern.test(rest)
	})
	const [firstMatch] = sortReadmeCandidates(matches)
	return firstMatch ?? null
}

export function listPackageFilesChildren(
	paths: Array<string>,
	directoryPath: string,
) {
	const prefix = directoryPath === '' ? '' : `${directoryPath}/`
	const children = new Map<string, PackageFilesKind>()
	for (const path of paths) {
		if (prefix && !path.startsWith(prefix)) continue
		const rest = prefix ? path.slice(prefix.length) : path
		if (!rest) continue
		const [name, ...nested] = rest.split('/')
		if (!name) continue
		const kind: PackageFilesKind = nested.length > 0 ? 'directory' : 'file'
		const existing = children.get(name)
		children.set(
			name,
			existing === 'directory' || kind === 'directory' ? 'directory' : 'file',
		)
	}
	return [...children.entries()]
		.sort(([leftName, leftKind], [rightName, rightKind]) => {
			if (leftKind !== rightKind) return leftKind === 'directory' ? -1 : 1
			return leftName.localeCompare(rightName, undefined, {
				sensitivity: 'base',
			})
		})
		.map(([name, kind]) => ({
			name,
			path: prefix ? `${prefix}${name}` : name,
			kind,
		}))
}

function directoryExists(paths: Array<string>, directoryPath: string) {
	if (directoryPath === '') return true
	const prefix = `${directoryPath}/`
	return paths.some((path) => path.startsWith(prefix))
}

/**
 * Build the explorer view for one selected path inside a published file map.
 * Returns null when the path is neither a file nor a directory in that map.
 * The package root (`''`) is always a directory, including an empty map.
 */
export function buildPackageFilesView(input: {
	files: Record<string, string>
	selectedPath: string
}): PackageFilesView | null {
	const paths = Object.keys(input.files).sort((left, right) =>
		left.localeCompare(right),
	)
	const selectedPath = input.selectedPath
	const isFile = selectedPath !== '' && Object.hasOwn(input.files, selectedPath)
	if (!isFile && !directoryExists(paths, selectedPath)) return null

	if (isFile) {
		const content = input.files[selectedPath] ?? ''
		const language = languageFromFilePath(selectedPath)
		return {
			paths,
			selectedPath,
			kind: 'file',
			content,
			contentPath: selectedPath,
			contentKind: contentKindFromLanguage(language),
			language,
			children: [],
		}
	}

	const contentPath = findDirectoryReadmePath(input.files, selectedPath)
	const content = contentPath ? (input.files[contentPath] ?? '') : null
	const language = contentPath ? languageFromFilePath(contentPath) : null
	return {
		paths,
		selectedPath,
		kind: 'directory',
		content,
		contentPath,
		contentKind: language ? contentKindFromLanguage(language) : null,
		language,
		children: listPackageFilesChildren(paths, selectedPath),
	}
}

export function getCommunityPackageFilesHref(input: {
	listingId: string
	ownerUsername?: string | null
	kodyId?: string | null
	relativePath?: string
}) {
	const relativePath = input.relativePath?.trim() || undefined
	if (
		input.ownerUsername &&
		input.kodyId &&
		!isReservedPackageFilesKodyId(input.kodyId)
	) {
		return relativePath
			? routes.communityPackageFiles.href({
					username: input.ownerUsername,
					kodyId: input.kodyId,
					relativePath,
				})
			: routes.communityPackageFiles.href({
					username: input.ownerUsername,
					kodyId: input.kodyId,
				})
	}
	return relativePath
		? routes.communityDetailFiles.href({
				listingId: input.listingId,
				relativePath,
			})
		: routes.communityDetailFiles.href({ listingId: input.listingId })
}

export function getAccountPackageFilesHref(input: {
	packageId: string
	relativePath?: string
}) {
	const relativePath = input.relativePath?.trim() || undefined
	return relativePath
		? routes.accountPackageFiles.href({
				packageId: input.packageId,
				relativePath,
			})
		: routes.accountPackageFiles.href({ packageId: input.packageId })
}

export function buildPackageFilesApiHref(
	apiPath: string,
	relativePath: string,
) {
	if (!relativePath) return apiPath
	const url = new URL(apiPath, 'http://localhost')
	url.searchParams.set('path', relativePath)
	return `${url.pathname}${url.search}`
}
