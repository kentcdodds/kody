import { CommunityActionError } from '#worker/community/errors.ts'

export type PackagePrivateFieldValue = true | false | undefined

function parsePackageJsonRecord(content: string): Record<string, unknown> {
	let parsed: unknown
	try {
		parsed = JSON.parse(content)
	} catch {
		throw new Error('Saved package package.json must be valid JSON.')
	}
	if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
		throw new Error('Saved package package.json must be a JSON object.')
	}
	return parsed as Record<string, unknown>
}

export function parsePackagePrivateField(
	content: string,
): PackagePrivateFieldValue {
	const parsed = parsePackageJsonRecord(content)
	if (!('private' in parsed)) {
		return undefined
	}
	const value = parsed['private']
	if (value === true) return true
	if (value === false) return false
	throw new Error(
		'Saved package package.json field "private" must be a boolean when present.',
	)
}

export function isPackagePrivate(content: string): boolean {
	return parsePackagePrivateField(content) === true
}

/**
 * Omitted `"private"` and `"private": true` are the same default-private
 * visibility. First `packageSave` injects `true` when the field is missing;
 * re-sending the author's unchanged files must not look like a change.
 */
function packagePrivateFieldSemantics(
	value: PackagePrivateFieldValue,
): 'private-default' | 'public-manifest' {
	return value === false ? 'public-manifest' : 'private-default'
}

export function packagePrivateFieldChanged(
	beforeContent: string | null | undefined,
	afterContent: string,
): boolean {
	const before =
		beforeContent == null ? undefined : parsePackagePrivateField(beforeContent)
	const after = parsePackagePrivateField(afterContent)
	return (
		packagePrivateFieldSemantics(before) !== packagePrivateFieldSemantics(after)
	)
}

export function requiresPrivateVisibilityConfirmation(input: {
	beforeContent: string | null | undefined
	afterContent: string
	isNewPackage: boolean
}): boolean {
	if (input.isNewPackage) {
		return !isPackagePrivate(input.afterContent)
	}
	return packagePrivateFieldChanged(input.beforeContent, input.afterContent)
}

export function assertPackageNotPrivateForCommunityPublish(
	packageJsonContent: string,
) {
	if (isPackagePrivate(packageJsonContent)) {
		// CommunityActionError so mcp observability keeps this caller-clearable
		// precondition off Sentry (KODY-CLOUDFLARE-5T).
		throw new CommunityActionError(
			'A package with `"private": true` in package.json cannot be published as a public package; set `"private": false` or remove `private` after the user explicitly approves sharing it publicly.',
		)
	}
}

export function injectDefaultPrivateField(content: string): string {
	const parsed = parsePackageJsonRecord(content)
	if ('private' in parsed) {
		return content
	}
	return `${JSON.stringify({ ...parsed, private: true }, null, '\t')}\n`
}
