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

export function packagePrivateFieldChanged(
	beforeContent: string | null | undefined,
	afterContent: string,
): boolean {
	const before =
		beforeContent == null ? undefined : parsePackagePrivateField(beforeContent)
	const after = parsePackagePrivateField(afterContent)
	return before !== after
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
		throw new Error(
			'community listings cannot publish packages with `"private": true` in package.json; set `"private": false` or remove `private` after the user explicitly approves public community sharing.',
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
