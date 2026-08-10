import { getSavedPackageByName } from '#worker/package-registry/repo.ts'
import { getPlatformAccountByUsername } from '#worker/package-registry/scope-grants.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'

export const packageSpecifierPrefix = 'kody:@'

export type KodyPackageSpecifier = {
	packageName: string
	exportName: string
}

/**
 * Resolution result for a `kody:@scope/name` import.
 *
 * `sourceOwnerUserId` is the user id the package *source* must be loaded
 * under. It equals the caller for the caller's own packages. For platform
 * (built-in) scopes — npm scopes whose username belongs to a platform
 * account (`users.account_type = 'platform'`, e.g. `@kody`) — imports
 * resolve live from the platform account's current published version, so
 * `sourceOwnerUserId` is the platform account's stable user id and
 * `platformScope` carries the scope username.
 *
 * Isolation invariant: platform resolution only widens *which published
 * source the bundler may read*. The resolved modules always execute in the
 * calling user's runtime against the caller's secrets, storage, and
 * entitlements — exactly like a fork would — and the caller's own copy
 * always wins, so forking a platform package to customize it keeps working.
 */
export type ResolvedPackageImport = {
	row: SavedPackageRecord
	sourceOwnerUserId: string
	platformScope: string | null
}

function unsupportedSpecifierError(specifier: string) {
	return new Error(`Unsupported Kody package specifier "${specifier}".`)
}

export function parseKodyPackageSpecifier(
	specifier: string,
): KodyPackageSpecifier {
	if (!specifier.startsWith(packageSpecifierPrefix)) {
		throw unsupportedSpecifierError(specifier)
	}

	const trimmed = specifier.slice(packageSpecifierPrefix.length).trim()
	if (!trimmed) {
		throw unsupportedSpecifierError(specifier)
	}

	const segments = trimmed.split('/').map((segment) => segment.trim())
	if (segments.length < 2 || segments[0] === '' || segments[1] === '') {
		throw unsupportedSpecifierError(specifier)
	}

	const scope = segments[0]
	const packageLeaf = segments[1]
	if (!scope || !packageLeaf) {
		throw unsupportedSpecifierError(specifier)
	}

	const packageName = `@${scope}/${packageLeaf}`
	const exportName = segments.slice(2).join('/').trim() || '.'

	return {
		packageName,
		exportName,
	}
}

export function packageScopeUsername(packageName: string): string | null {
	const match = /^@([^/]+)\//.exec(packageName)
	return match?.[1] ?? null
}

export async function resolveSavedPackageImport(input: {
	db: D1Database
	userId: string
	specifier: string | KodyPackageSpecifier
	/**
	 * The dynamic-import hydration lane persists rebuilt artifacts under the
	 * caller's identity, which must never happen for platform-owned sources;
	 * it opts out and reports a teaching error instead.
	 */
	allowPlatformScopes?: boolean
}): Promise<ResolvedPackageImport | null> {
	const parsed =
		typeof input.specifier === 'string'
			? parseKodyPackageSpecifier(input.specifier)
			: input.specifier

	const own = await getSavedPackageByName(input.db, {
		userId: input.userId,
		name: parsed.packageName,
	})
	if (own) {
		return {
			row: own,
			sourceOwnerUserId: input.userId,
			platformScope: null,
		}
	}
	if (input.allowPlatformScopes === false) return null
	return await resolvePlatformScopedPackageImport({
		db: input.db,
		packageName: parsed.packageName,
	})
}

export async function resolvePlatformScopedPackageImport(input: {
	db: D1Database
	packageName: string
}): Promise<ResolvedPackageImport | null> {
	const scopeUsername = packageScopeUsername(input.packageName)
	if (!scopeUsername) return null
	const platformAccount = await getPlatformAccountByUsername(
		input.db,
		scopeUsername,
	)
	if (!platformAccount) return null
	const row = await getSavedPackageByName(input.db, {
		userId: platformAccount.stableUserId,
		name: input.packageName,
	})
	// Hidden and private platform packages are the operator's "not ready" /
	// "not for everyone" switches; they stay resolvable only to the owner
	// (who resolves via the own-copy lane).
	if (!row || row.hidden || row.isPrivate) return null
	return {
		row,
		sourceOwnerUserId: platformAccount.stableUserId,
		platformScope: scopeUsername,
	}
}
