import { getDiscoverablePlatformOauthApp } from '#worker/integrations/platform-apps.ts'
import { type PackageCredentialKind } from '#worker/package-registry/types.ts'
import { buildCredentialCreateUrl } from '#universal/credential-contracts.ts'
import { type CredentialNeed } from './credential-needs.ts'

const providerSlugPattern = /^[a-z0-9-]+$/

/**
 * The creation link for a need. A declared kind is locked; without one the
 * page suggests OAuth when a built-in app exists for the provider, else a
 * Key, and shows the kind chooser. A built-in app is selected with
 * `platform` whenever the need takes OAuth.
 */
export async function buildNeedCreateUrl(input: {
	db: D1Database
	baseUrl: string
	key: string
	provider: string
	need: CredentialNeed | null
	packageKodyId: string | null
	orgSlug: string | null
}) {
	const declaredKind: PackageCredentialKind | null = input.need?.kind ?? null
	const providerSlug = providerSlugPattern.test(input.provider)
		? input.provider
		: null
	const builtInOauth =
		(declaredKind === null || declaredKind === 'oauth') && providerSlug
			? await getDiscoverablePlatformOauthApp({
					db: input.db,
					slug: providerSlug,
				}).catch(() => null)
			: null
	return buildCredentialCreateUrl(input.baseUrl, {
		kind: declaredKind ?? (builtInOauth ? 'oauth' : 'secret'),
		kindMode: declaredKind ? 'required' : 'hint',
		name: input.key,
		provider: providerSlug,
		description: input.need?.description,
		packageKodyId: input.packageKodyId,
		needKey: input.need ? input.key : null,
		orgSlug: input.orgSlug,
		extra: builtInOauth && providerSlug ? { platform: providerSlug } : {},
	})
}
