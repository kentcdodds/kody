import { collectStaticKodyPackageImportsFromFiles } from '#worker/package-runtime/static-kody-imports.ts'
import { getPlatformAccountByUsername } from './scope-grants.ts'
import { listKodyPackageDependencyNames } from './types.ts'

/**
 * Official `@kody/*` (and any other platform-account scope) packages are
 * execute-only. Ad hoc execute may import or `packages.invoke` them live.
 * Saved person-account packages must fork into the caller's scope. Decision
 * 0035; this supersedes the package-import half of 0014.
 */
export const personPackagePlatformDependencyMessage =
	'Official platform packages are execute-only. Ad hoc execute may import or packages.invoke them live. Saved packages must community_fork the official package into your scope and depend on that copy — platform APIs are not a stable package dependency.'

export function formatPersonPackagePlatformDependencyMessage(
	packageName: string,
) {
	return `${personPackagePlatformDependencyMessage} Offending reference: ${packageName}.`
}

const invokeSpecifierPattern =
	/packages\.invoke\s*\(\s*(['"`])((?:kody:)?@[a-z0-9][a-z0-9._-]*\/[^'"`]+)\1/g

function packageNameFromInvokeSpecifier(raw: string): string | null {
	const trimmed = raw.startsWith('kody:') ? raw.slice('kody:'.length) : raw
	const match = /^@([^/]+)\/([^/]+)/.exec(trimmed)
	return match?.[1] && match[2] ? `@${match[1]}/${match[2]}` : null
}

function packageScopeUsername(packageName: string): string | null {
	const match = /^@([^/]+)\//.exec(packageName)
	return match?.[1] ?? null
}

export function collectScopedPackageNamesFromSource(input: {
	manifestDependencies?: Array<string> | Record<string, string> | null
	sourceFiles: Record<string, string>
}): Array<string> {
	const names = new Set<string>()
	for (const dependency of listKodyPackageDependencyNames(
		input.manifestDependencies,
	)) {
		names.add(dependency)
	}
	for (const imported of collectStaticKodyPackageImportsFromFiles(
		input.sourceFiles,
	)) {
		names.add(imported.packageName)
	}
	for (const content of Object.values(input.sourceFiles)) {
		for (const match of content.matchAll(invokeSpecifierPattern)) {
			const packageName = packageNameFromInvokeSpecifier(match[2] ?? '')
			if (packageName) names.add(packageName)
		}
	}
	return [...names].sort((left, right) => left.localeCompare(right))
}

export async function findPlatformScopedPackageName(input: {
	db: D1Database
	packageNames: ReadonlyArray<string>
}): Promise<string | null> {
	for (const packageName of input.packageNames) {
		const scope = packageScopeUsername(packageName)
		if (!scope) continue
		if (await getPlatformAccountByUsername(input.db, scope)) {
			return packageName
		}
	}
	return null
}

export async function findPersonPackagePlatformReference(input: {
	db: D1Database
	manifestDependencies?: Array<string> | Record<string, string> | null
	sourceFiles: Record<string, string>
}): Promise<string | null> {
	return await findPlatformScopedPackageName({
		db: input.db,
		packageNames: collectScopedPackageNamesFromSource(input),
	})
}

/** Fail closed only when the missing name is a platform-account scope. */
export async function throwIfPersonPackagePlatformReference(input: {
	db: D1Database
	packageName: string
}): Promise<void> {
	const platformName = await findPlatformScopedPackageName({
		db: input.db,
		packageNames: [input.packageName],
	})
	if (platformName) {
		throw new Error(formatPersonPackagePlatformDependencyMessage(platformName))
	}
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
	const pattern = new RegExp(`${escaped}(?=/|["'\\s,]|$)`, 'g')
	const files: Record<string, string> = {}
	for (const [path, content] of Object.entries(input.files)) {
		files[path] = content.includes(origin)
			? content.replace(pattern, next)
			: content
	}
	return files
}
