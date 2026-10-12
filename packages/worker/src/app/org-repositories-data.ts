import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { toPublicProfilePackageItem } from '#app/community-public.ts'
import {
	canSeeResource,
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { listProfileRepositories } from '#worker/community/profile-service.ts'
import { buildOrgAvatarUrl } from '#worker/orgs/org-avatar.ts'
import { type OrgBinding } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { type ProfileLoaderData } from '#universal/loader-data.ts'

const maxOrgRepositoriesLimit = 100

function readOptionalLimit(raw: string | null) {
	if (raw == null || raw === '') return undefined
	const parsed = Number.parseInt(raw, 10)
	if (!Number.isFinite(parsed) || parsed < 1) return undefined
	return Math.min(parsed, maxOrgRepositoriesLimit)
}

/**
 * Repositories owned by a team org (`saved_packages` and `user_repos` with
 * `user_id = org.id`), for `/@slug/-/repositories`. Packages pass `canSeeResource`
 * (owners see everything; members see grants). Plain repos have no grant
 * surface — every org member who can open this page sees them (same inventory
 * as MCP `repoList` for the bound org).
 */
export async function loadOrgRepositoriesData(input: {
	env: Env
	request: Request
	user: { mcpUser: McpUserContext }
	binding: OrgBinding
}): Promise<ProfileLoaderData> {
	const orgId = input.binding.org.id
	const slug = input.binding.org.slug ?? ''
	const url = new URL(input.request.url)
	const query = url.searchParams.get('q')?.trim() ?? ''
	const limit = readOptionalLimit(url.searchParams.get('limit'))
	const [org, access, repositories] = await Promise.all([
		input.env.APP_DB.prepare(
			`SELECT display_name, avatar_key, created_at FROM orgs WHERE id = ? AND deleted_at IS NULL`,
		)
			.bind(orgId)
			.first<{
				display_name: string | null
				avatar_key: string | null
				created_at: string
			}>(),
		computeEffectivePermissions({
			env: input.env,
			request: deriveRequestContext({
				user: input.user.mcpUser,
				source: { kind: 'session' },
				orgBinding: input.binding,
			}),
		}),
		// Uncapped: the cap applies after the package visibility filter, or
		// packages the viewer cannot see could fill it and hide ones they can.
		listProfileRepositories({
			env: input.env,
			ownerStableUserId: orgId,
			ownerUsername: slug,
			...(limit != null && query ? { query } : {}),
			includePrivate: true,
		}),
	])
	const allVisible = repositories.filter((pkg) => {
		if (!pkg.hasPackage) return true
		return canSeeResource(
			access,
			packageResource({ id: pkg.packageId, userId: orgId, label: pkg.name }),
		)
	})
	const visible = limit == null ? allVisible : allVisible.slice(0, limit)
	return {
		ok: true,
		profile: {
			username: slug,
			displayName: org?.display_name?.trim() || `@${slug}`,
			bio: null,
			avatarUrl: buildOrgAvatarUrl({
				slug,
				avatarKey: org?.avatar_key ?? null,
			}),
			visibility: 'public',
			joinedAt: org?.created_at ?? '',
			publicPackageCount: visible.filter((pkg) => !pkg.isPrivate).length,
			listingCount: visible.filter((pkg) => pkg.communityListingId).length,
		},
		packages: visible.map((pkg) => {
			if (!pkg.hasPackage) {
				return toPublicProfilePackageItem(pkg, {
					includeOwnerVisibility: true,
					username: slug,
				})
			}
			const resource = packageResource({
				id: pkg.packageId,
				userId: orgId,
				label: pkg.name,
			})
			// List visibility is broader than the owner package page
			// (read|execute|write). Link when the viewer can open that page
			// (`package:read`), or when a public community listing makes the
			// canonical `/@slug/kodyId` URL resolve without read.
			const canOpenDetail =
				checkPermission(access, 'package:read', resource).allowed ||
				Boolean(pkg.communityListingId)
			return toPublicProfilePackageItem(pkg, {
				includeOwnerVisibility: true,
				username: slug,
				canOpenDetail,
			})
		}),
		activity: null,
		query: query || null,
		isSelf: true,
		loggedIn: true,
	}
}
