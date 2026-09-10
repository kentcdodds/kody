import { z } from 'zod'
import { kodyPackageIdPattern } from './types.ts'

export const packageNameLeafPattern = kodyPackageIdPattern

const scopedPackageNamePattern =
	/^@([a-z0-9][a-z0-9._-]*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/i

export const packageNameInputDescription =
	'Package name leaf (`my-package`) or scoped name (`@owner/my-package`). When scoped, the owner must match the acting package scope. Prefer `package_id` when you already have the UUID.'

export const packageIdentityChoiceDescription =
	'Provide exactly one of `package_id` or `package_name`.'

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
		input.action === 'create' ? 'Cannot create package' : 'Invalid package_name'
	return `${action}: ${JSON.stringify(input.value)} must be a lower-kebab-case package name leaf (for example "my-package") or a scoped name for this account (for example "@${exampleScope}/my-package").`
}

export function mismatchedPackageScopeMessage(input: {
	value: string
	requestedScope: string
	ownerScope: string
}) {
	const owner = input.ownerScope.replace(/^@/, '')
	const requested = input.requestedScope.replace(/^@/, '')
	return `Cannot use package_name ${JSON.stringify(input.value)}: scope "@${requested}" does not match the acting owner "@${owner}". Use the leaf after "/" or "@${owner}/…".`
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

/**
 * Map leftover `kody_id` / `kodyId` onto `package_name` so in-flight agent
 * transcripts keep working. Public schemas do not advertise the old field.
 */
export function applyPackageNameAliases(value: unknown) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return value
	}
	const record = value as Record<string, unknown>
	const normalized: Record<string, unknown> = { ...record }
	if (normalized['package_name'] === undefined) {
		if ('packageName' in record) {
			normalized['package_name'] = record['packageName']
			delete normalized['packageName']
		} else if ('kody_id' in record) {
			normalized['package_name'] = record['kody_id']
			delete normalized['kody_id']
		} else if ('kodyId' in record) {
			normalized['package_name'] = record['kodyId']
			delete normalized['kodyId']
		}
	} else {
		delete normalized['kody_id']
		delete normalized['kodyId']
		delete normalized['packageName']
	}
	return normalized
}

export function countPackageIdentityFields(input: {
	package_id?: string
	package_name?: string
}) {
	return (
		(input.package_id !== undefined ? 1 : 0) +
		(input.package_name !== undefined ? 1 : 0)
	)
}

export const packageIdInputSchema = z
	.string()
	.min(1)
	.describe('Saved package UUID.')

export const packageNameInputSchema = z
	.string()
	.min(1)
	.describe(packageNameInputDescription)

export const packageIdentityInputShape = {
	package_id: packageIdInputSchema.optional(),
	package_name: packageNameInputSchema.optional(),
}

export function refineExactlyOnePackageIdentity(
	value: { package_id?: string; package_name?: string },
	ctx: z.RefinementCtx,
) {
	if (countPackageIdentityFields(value) !== 1) {
		ctx.addIssue({
			code: 'custom',
			message: packageIdentityChoiceDescription,
		})
	}
}
