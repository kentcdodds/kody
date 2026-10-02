/**
 * Path helpers for workspace module names that must stay free of the package
 * registry / import-resolution graph. Local-execute runtime support (additional
 * Worker module) and the inlined-CAF rewriter import only from here so their
 * deferred bundle does not pull isomorphic-git / D1 registry code onto a
 * second copy of those libraries.
 */

export const runtimeModulePath = '.__kody_virtual__/runtime.js'

export function joinPath(...parts: Array<string>) {
	return parts
		.join('/')
		.replace(/\/+/g, '/')
		.replace(/\/\.\//g, '/')
}

export function dirname(filePath: string) {
	const normalized = filePath.replace(/\/+/g, '/')
	const separator = normalized.lastIndexOf('/')
	return separator === -1 ? '.' : normalized.slice(0, separator) || '.'
}

export function relativePath(fromDir: string, toPath: string) {
	const fromParts = fromDir.split('/').filter(Boolean)
	const toParts = toPath.split('/').filter(Boolean)
	let sharedIndex = 0
	while (
		sharedIndex < fromParts.length &&
		sharedIndex < toParts.length &&
		fromParts[sharedIndex] === toParts[sharedIndex]
	) {
		sharedIndex += 1
	}
	const upward = fromParts.slice(sharedIndex).map(() => '..')
	const downward = toParts.slice(sharedIndex)
	return [...upward, ...downward].join('/')
}

export function createRelativeImportSpecifier(
	fromPath: string,
	targetPath: string,
) {
	const fromDir = dirname(fromPath)
	const relative = relativePath(fromDir, targetPath)
	const normalized =
		relative === '.' || relative.startsWith('./') || relative.startsWith('../')
			? relative
			: `./${relative}`
	return normalized.replaceAll('\\', '/')
}

export function normalizeWorkspaceModulePath(path: string) {
	const parts: Array<string> = []
	for (const segment of path.replace(/\\/g, '/').split('/')) {
		if (!segment || segment === '.') continue
		if (segment === '..') {
			parts.pop()
			continue
		}
		parts.push(segment)
	}
	return parts.join('/')
}
