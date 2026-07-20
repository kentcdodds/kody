/**
 * Rewrite a saved package's scope when the owning user's username changes.
 *
 * Package names are `@{username}/{kodyId}`. Username changes must update
 * `package.json#name` and any same-account references that embed that scope
 * (`kody.dependencies`, `kody.emits` / `kody.subscriptions` topic keys, and
 * `kody:@scope/...` imports in source files).
 */

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizePackageScope(scope: string) {
	return scope.trim().replace(/^@/, '').toLowerCase()
}

/**
 * Replace `@oldScope/` with `@newScope/` only when the old token is an exact
 * scope segment (not a longer username that shares a prefix).
 */
export function rewriteScopedPackageReferences(
	content: string,
	input: { previousScope: string; nextScope: string },
) {
	const previousScope = normalizePackageScope(input.previousScope)
	const nextScope = normalizePackageScope(input.nextScope)
	if (!previousScope || previousScope === nextScope) {
		return content
	}
	const pattern = new RegExp(`@${escapeRegExp(previousScope)}(?=/)`, 'g')
	return content.replace(pattern, `@${nextScope}`)
}

export function buildPackageNameForScope(input: {
	scope: string
	kodyId: string
}) {
	return `@${normalizePackageScope(input.scope)}/${input.kodyId}`
}

export type UsernameScopeRewriteResult = {
	files: Record<string, string>
	changedPaths: Array<string>
	previousName: string | null
	nextName: string
	changed: boolean
}

/**
 * Rewrite package files from one username scope to another.
 * Only paths whose content actually changes are listed in `changedPaths`.
 */
export function rewritePackageFilesForUsernameChange(input: {
	files: Record<string, string>
	previousScope: string
	nextScope: string
	kodyId: string
}): UsernameScopeRewriteResult {
	const previousScope = normalizePackageScope(input.previousScope)
	const nextScope = normalizePackageScope(input.nextScope)
	const nextName = buildPackageNameForScope({
		scope: nextScope,
		kodyId: input.kodyId,
	})
	const previousName = buildPackageNameForScope({
		scope: previousScope,
		kodyId: input.kodyId,
	})

	if (!previousScope || previousScope === nextScope) {
		return {
			files: { ...input.files },
			changedPaths: [],
			previousName,
			nextName,
			changed: false,
		}
	}

	const files: Record<string, string> = {}
	const changedPaths: Array<string> = []
	const needle = `@${previousScope}/`

	for (const [path, content] of Object.entries(input.files)) {
		if (!content.includes(needle)) {
			files[path] = content
			continue
		}
		const nextContent = rewriteScopedPackageReferences(content, {
			previousScope,
			nextScope,
		})
		files[path] = nextContent
		if (nextContent !== content) {
			changedPaths.push(path)
		}
	}

	changedPaths.sort((left, right) => left.localeCompare(right))

	return {
		files,
		changedPaths,
		previousName,
		nextName,
		changed: changedPaths.length > 0,
	}
}
