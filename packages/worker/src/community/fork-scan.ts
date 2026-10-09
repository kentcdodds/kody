import { listKodyPackageDependencyNames } from '#worker/package-registry/types.ts'
import { type CrossScopeReference } from './types.ts'

const kodyImportPattern = /kody:@([a-z0-9][a-z0-9._-]*)\//g
const scopedPackageNamePattern = /^@([a-z0-9][a-z0-9._-]*)\//

function normalizePackageScope(scope: string) {
	return scope.trim().replace(/^@/, '').toLowerCase()
}

function getScopeFromScopedName(name: string) {
	const match = scopedPackageNamePattern.exec(name.trim())
	return match?.[1] ?? null
}

function addCrossScopeReference(
	seen: Set<string>,
	results: Array<CrossScopeReference>,
	input: CrossScopeReference,
) {
	const key = `${input.file}\0${input.specifier}`
	if (seen.has(key)) return
	seen.add(key)
	results.push(input)
}

export function rewritePackageManifestForFork(input: {
	manifestContent: string
	expectedPackageScope: string
	targetKodyId: string
}): { content: string; targetName: string } {
	const parsed = JSON.parse(input.manifestContent) as Record<string, unknown>
	const scope = normalizePackageScope(input.expectedPackageScope)
	const targetName = `@${scope}/${input.targetKodyId}`
	const next = {
		...parsed,
		name: targetName,
		private: true,
		kody: {
			...(typeof parsed['kody'] === 'object' && parsed['kody'] != null
				? (parsed['kody'] as Record<string, unknown>)
				: {}),
			id: input.targetKodyId,
		},
	}
	return {
		content: `${JSON.stringify(next, null, '\t')}\n`,
		targetName,
	}
}

export function scanCrossScopeReferences(input: {
	files: Record<string, string>
	expectedPackageScope: string
}): Array<CrossScopeReference> {
	const expectedScope = normalizePackageScope(input.expectedPackageScope)
	const isForeign = (scope: string) =>
		normalizePackageScope(scope) !== expectedScope
	const seen = new Set<string>()
	const results: Array<CrossScopeReference> = []

	for (const [file, content] of Object.entries(input.files)) {
		if (file === 'package.json') {
			try {
				const parsed = JSON.parse(content) as {
					kody?: { dependencies?: Array<string> | Record<string, string> }
				}
				for (const dependency of listKodyPackageDependencyNames(
					parsed.kody?.dependencies,
				)) {
					const dependencyScope = getScopeFromScopedName(dependency)
					if (dependencyScope != null && isForeign(dependencyScope)) {
						addCrossScopeReference(seen, results, {
							file,
							specifier: dependency,
						})
					}
				}
			} catch {
				// package.json is validated elsewhere before fork.
			}
		}

		for (const match of content.matchAll(kodyImportPattern)) {
			const importScope = match[1]
			if (importScope != null && isForeign(importScope)) {
				addCrossScopeReference(seen, results, {
					file,
					specifier: `kody:@${importScope}/`,
				})
			}
		}
	}

	return results.sort((left, right) => {
		const fileCompare = left.file.localeCompare(right.file)
		if (fileCompare !== 0) return fileCompare
		return left.specifier.localeCompare(right.specifier)
	})
}

export function rewriteForkedPackageSelfReferences(input: {
	files: Record<string, string>
	originPackageName: string
	nextPackageName: string
}): Record<string, string> {
	const origin = input.originPackageName.trim()
	const next = input.nextPackageName.trim()
	if (!origin || origin === next) {
		return { ...input.files }
	}
	const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const pattern = new RegExp(`${escaped}(?=/|["'\`\\s,]|$)`, 'g')
	const files: Record<string, string> = {}
	for (const [path, content] of Object.entries(input.files)) {
		files[path] = content.includes(origin)
			? content.replace(pattern, next)
			: content
	}
	return files
}

/**
 * Files whose contents changed during fork rewrite (typically `package.json`
 * plus any self-references). The storage-layer copy already has the origin
 * tree; only these paths should be written back.
 */
export function collectChangedForkFiles(input: {
	originFiles: Record<string, string>
	rewrittenFiles: Record<string, string>
}): Record<string, string> {
	const changed: Record<string, string> = {}
	for (const [path, content] of Object.entries(input.rewrittenFiles)) {
		if (input.originFiles[path] !== content) {
			changed[path] = content
		}
	}
	return changed
}
