/**
 * Package credential needs (ADR 0068, `kody.credentials`). A need is a keyed
 * request for a credential of a provider (and optionally a kind); callers pick
 * which of their credentials fills it, or it auto-resolves to the one
 * candidate. Omitting `kind` matches any fetch-capable credential for the
 * provider (secret/Key, oauth, login).
 *
 * A package's needs closure is its own needs plus those of the packages it
 * statically imports, pinned at its publish (dependencies are snapshotted
 * then too, per ADR 0001) and stored with its published manifest snapshot.
 * Declaring needs never changes how Key placeholders fill.
 */
import { z } from 'zod'
import {
	isFetchCapableCredentialKind,
	packageCredentialKindValues,
	type AuthoredPackageJson,
	type PackageCredentialKind,
} from '#worker/package-registry/types.ts'

export const credentialNeedSchema = z.object({
	key: z.string(),
	kind: z.enum(packageCredentialKindValues).optional(),
	provider: z.string(),
	description: z.string(),
	multiple: z.boolean(),
	/** The dependency that declared an inherited need. */
	from: z.string().optional(),
})

export type CredentialNeed = z.infer<typeof credentialNeedSchema>

export const credentialNeedsClosureSchema = z.array(credentialNeedSchema)

const providerSlugPattern = /^[a-z0-9-]+$/

type ManifestCredentials = AuthoredPackageJson['kody']['credentials']

/** The package's own declared needs, with `provider` defaulted to the key. */
export function ownCredentialNeeds(
	credentials: ManifestCredentials,
): Array<CredentialNeed> {
	return Object.entries(credentials ?? {})
		.map(([key, slot]) => ({
			key,
			...(slot.kind ? { kind: slot.kind } : {}),
			provider: slot.provider ?? key,
			description: slot.description,
			multiple: slot.multiple === true,
		}))
		.sort((left, right) => left.key.localeCompare(right.key))
}

function describeNeedKind(kind: PackageCredentialKind | undefined): string {
	return kind ?? 'any fetch-capable kind'
}

/**
 * Two needs for the same key agree when providers match and kinds are
 * compatible: equal kinds, both omitted, or one omitted and the other a
 * fetch-capable kind (the declared kind is kept).
 */
export function credentialNeedKindsCompatible(
	left: PackageCredentialKind | undefined,
	right: PackageCredentialKind | undefined,
): boolean {
	if (left === right) return true
	if (left == null) return right != null && isFetchCapableCredentialKind(right)
	if (right == null) return isFetchCapableCredentialKind(left)
	return false
}

export function mergeCredentialNeedKinds(
	left: PackageCredentialKind | undefined,
	right: PackageCredentialKind | undefined,
): PackageCredentialKind | undefined {
	return left ?? right
}

/**
 * Publish notes for keys that are not provider slugs. They never fail a
 * publish: the need still works when a caller picks a credential for it.
 */
export function credentialNeedKeyNotes(
	credentials: ManifestCredentials,
): Array<string> {
	return Object.entries(credentials ?? {}).flatMap(([key, slot]) => {
		if (providerSlugPattern.test(key)) return []
		const provider = slot.provider ?? key
		return [
			providerSlugPattern.test(provider)
				? `kody.credentials.${key}: keys usually name their provider; "${provider}" would read more clearly as the key.`
				: `kody.credentials.${key}: "${provider}" is not a provider slug (lowercase letters, numbers, hyphens), so no credential auto-resolves for it; callers pick one for this need instead.`,
		]
	})
}

export type DependencyCredentialNeeds = {
	packageName: string
	needs: ReadonlyArray<CredentialNeed>
}

/**
 * Own needs first, then each dependency's closure. A key declared twice must
 * agree on provider and compatible kinds; any disagreement is returned as a
 * conflict. When one side omits `kind` and the other declares a fetch-capable
 * kind, the declared kind is kept.
 */
export function mergeCredentialNeeds(input: {
	own: ReadonlyArray<CredentialNeed>
	dependencies: ReadonlyArray<DependencyCredentialNeeds>
}): { needs: Array<CredentialNeed>; conflicts: Array<string> } {
	const byKey = new Map<string, CredentialNeed>()
	const conflicts: Array<string> = []
	const describe = (need: CredentialNeed) =>
		`${describeNeedKind(need.kind)} from provider "${need.provider}" (${need.from ? `declared by ${need.from}` : 'declared by this package'})`
	const add = (need: CredentialNeed) => {
		const existing = byKey.get(need.key)
		if (!existing) {
			byKey.set(need.key, need)
			return
		}
		if (
			existing.provider !== need.provider ||
			!credentialNeedKindsCompatible(existing.kind, need.kind)
		) {
			conflicts.push(
				`kody.credentials.${need.key}: ${describe(existing)} conflicts with ${describe(need)}. Give one of them a different key.`,
			)
			return
		}
		const kind = mergeCredentialNeedKinds(existing.kind, need.kind)
		const multiple = need.multiple || existing.multiple
		byKey.set(need.key, {
			key: existing.key,
			provider: existing.provider,
			description: existing.description,
			multiple,
			...(kind ? { kind } : {}),
			...(existing.from ? { from: existing.from } : {}),
		})
	}
	for (const need of input.own) add(need)
	for (const dependency of input.dependencies) {
		for (const need of dependency.needs) {
			add({ ...need, from: need.from ?? dependency.packageName })
		}
	}
	return {
		needs: [...byKey.values()].sort((left, right) =>
			left.key.localeCompare(right.key),
		),
		conflicts,
	}
}

/** Parses a stored closure; anything unreadable counts as not stored. */
export function readStoredCredentialNeeds(
	value: unknown,
): Array<CredentialNeed> | null {
	const parsed = credentialNeedsClosureSchema.safeParse(value)
	return parsed.success ? parsed.data : null
}
