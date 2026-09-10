import { kodyPackageIdPattern } from './types.ts'

export const packageNameLeafPattern = kodyPackageIdPattern

/** Agent-facing lookup copy: lead with the scoped name; `package_id` is fallback. */
export const packageNameLookupDescription =
	'Package name (`@owner/leaf` or the name leaf). Prefer this when you know the name.'

export const packageIdLookupDescription =
	'Saved-package UUID. Use when the scoped name is not known, or for a stable ref.'

const scopedPackageNamePattern =
	/^@([a-z0-9][a-z0-9._-]*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/i

export function getPackageNameLeaf(name: string) {
	const trimmed = name.trim()
	const separator = trimmed.indexOf('/')
	return separator === -1 ? trimmed : trimmed.slice(separator + 1)
}

export function getPackageNameScope(name: string) {
	const trimmed = name.trim()
	const separator = trimmed.indexOf('/')
	if (separator <= 1 || !trimmed.startsWith('@')) return null
	return trimmed.slice(1, separator)
}

export function isScopedPackageName(name: string) {
	const trimmed = name.trim()
	if (!trimmed.startsWith('@')) return false
	const separator = trimmed.indexOf('/')
	return separator > 1 && separator < trimmed.length - 1
}

export function invalidPackageNameMessage(input: {
	value: string
	ownerScope?: string
	action?: 'create' | 'resolve'
}) {
	const exampleScope = (input.ownerScope ?? 'owner').replace(/^@/, '')
	const action =
		input.action === 'create' ? 'Cannot create package' : 'Invalid package name'
	return `${action}: ${JSON.stringify(input.value)} must be a lower-kebab-case package name leaf (for example "my-package") or a scoped name for this account (for example "@${exampleScope}/my-package").`
}

export function mismatchedPackageScopeMessage(input: {
	value: string
	requestedScope: string
	ownerScope: string
}) {
	const owner = input.ownerScope.replace(/^@/, '')
	const requested = input.requestedScope.replace(/^@/, '')
	return `Cannot use package name ${JSON.stringify(input.value)}: scope "@${requested}" does not match the acting owner "@${owner}". Use the leaf after "/" or "@${owner}/…".`
}

/**
 * Accept a leaf (`mailchimp`) or scoped name (`@grant/mailchimp`).
 * Matching owner scope is stripped; a different scope is rejected.
 */
export function normalizePackageNameInput(input: {
	value: string
	ownerScope: string
	action?: 'create' | 'resolve'
}): string {
	const value = input.value.trim()
	const ownerScope = input.ownerScope.trim().replace(/^@/, '').toLowerCase()
	if (!value) {
		throw new Error(
			invalidPackageNameMessage({
				value: input.value,
				ownerScope,
				action: input.action,
			}),
		)
	}

	const scoped = value.match(scopedPackageNamePattern)
	if (scoped) {
		const requestedScope = (scoped[1] ?? '').toLowerCase()
		const leaf = scoped[2] ?? ''
		if (requestedScope !== ownerScope) {
			throw new Error(
				mismatchedPackageScopeMessage({
					value: input.value,
					requestedScope,
					ownerScope,
				}),
			)
		}
		if (!packageNameLeafPattern.test(leaf)) {
			throw new Error(
				invalidPackageNameMessage({
					value: input.value,
					ownerScope,
					action: input.action,
				}),
			)
		}
		return leaf
	}

	if (value.startsWith('@') || value.includes('/')) {
		throw new Error(
			invalidPackageNameMessage({
				value: input.value,
				ownerScope,
				action: input.action,
			}),
		)
	}

	if (!packageNameLeafPattern.test(value)) {
		throw new Error(
			invalidPackageNameMessage({
				value: input.value,
				ownerScope,
				action: input.action,
			}),
		)
	}
	return value
}
