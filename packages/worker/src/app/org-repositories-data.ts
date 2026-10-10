import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { toPublicProfilePackageItem } from '#app/community-public.ts'
import {
	canSeeResource,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { listPublicProfilePackages } from '#worker/community/profile-service.ts'
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
 * Repositories owned by a team org (`saved_packages.user_id = org.id`), for
 * `/@slug/-/packages`. Each row is shown only when the viewer can see that
 * package (`canSeeResource`): Owners see everything, other members see what
 * their grants and teams give them. Team packages have no `/@slug/<kody-id>`
 * page yet, so rows do not link to one.
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
	const [org, access, packages] = await Promise.all([
		input.env.APP_DB.prepare(
			`SELECT display_name, avatar_key, created_at FROM orgs WHERE id = ?`,
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
		listPublicProfilePackages({
			env: input.env,
			ownerStableUserId: orgId,
			...(limit != null && query ? { query } : {}),
			...(limit == null ? {} : { limit }),
			includePrivate: true,
		}),
	])
	const visible = packages.filter((pkg) =>
		canSeeResource(
			access,
			packageResource({ id: pkg.packageId, userId: orgId, label: pkg.name }),
		),
	)
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
		packages: visible.map((pkg) =>
			toPublicProfilePackageItem(pkg, { includeOwnerVisibility: true }),
		),
		activity: [],
		query: query || null,
		isSelf: true,
		loggedIn: true,
		packageLinks: false,
	}
}
