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
	/**
	 * Scopes that remain valid in any account — platform (built-in) scopes
	 * such as `@kody`, whose packages resolve live for every caller — so
	 * forks keep referencing them instead of being told to rewrite.
	 */
	allowedForeignScopes?: ReadonlyArray<string>
}): Array<CrossScopeReference> {
	const expectedScope = normalizePackageScope(input.expectedPackageScope)
	const allowedScopes = new Set(
		(input.allowedForeignScopes ?? []).map((scope) =>
			normalizePackageScope(scope),
		),
	)
	const isForeign = (scope: string) => {
		const normalized = normalizePackageScope(scope)
		return normalized !== expectedScope && !allowedScopes.has(normalized)
	}
	const seen = new Set<string>()
	const results: Array<CrossScopeReference> = []

	for (const [file, content] of Object.entries(input.files)) {
		if (file === 'package.json') {
			try {
				const parsed = JSON.parse(content) as {
					kody?: { dependencies?: Array<string> }
				}
				for (const dependency of parsed.kody?.dependencies ?? []) {
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
