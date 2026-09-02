import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadCommunityDetailData } from '#app/community-data.ts'
import {
	buildSourceAheadPublishHref,
	renderCommunityDetailContentHtml,
} from '#app/community-detail-content.tsx'
import { resolveCommunityListingRoute } from '#app/community-package-route.ts'
import { registerFrame } from '#app/frame-registry.ts'
import { loadPackagePage } from '#app/package-page.ts'
import { type PublicCommunityListing } from '#app/community-public.ts'
import { COMMUNITY_DETAIL_TARGET } from '#universal/community-frame-constants.ts'
import { routes } from '#universal/routes.ts'
import { getSavedPackageByKodyId } from '#worker/package-registry/repo.ts'
import { createMatcher } from 'remix/route-pattern/match'

const communityPackageMatcher = createMatcher(routes.communityPackage.pattern)

async function resolvePublishCompareHref(input: {
	env: Env
	request: Request
	viewerIsOwner: boolean
	listing: PublicCommunityListing | null
	packageId?: string | null
}) {
	if (!input.viewerIsOwner || !input.listing?.sourceAhead) return null
	let packageId = input.packageId ?? null
	if (!packageId) {
		const user = await readAuthenticatedAppUser(input.request, input.env)
		if (user) {
			const ownerPackage = await getSavedPackageByKodyId(input.env.APP_DB, {
				userId: user.mcpUser.userId,
				kodyId: input.listing.kodyId,
			})
			packageId = ownerPackage?.id ?? null
		}
	}
	return buildSourceAheadPublishHref({
		packageId,
		headCommit: input.listing.headCommit,
	})
}

registerFrame(COMMUNITY_DETAIL_TARGET, {
	routes: [routes.communityPackage, routes.communityDetail],
	render: async ({ request, env, url }) => {
		const packageParams = communityPackageMatcher.match(url)?.params
		if (packageParams) {
			const page = await loadPackagePage({
				env,
				request,
				username: packageParams.username,
				kodyId: packageParams.kodyId,
			})
			if (page.kind !== 'page') return ''
			const listing = page.listing?.listing ?? null
			return renderCommunityDetailContentHtml({
				listing,
				username: page.username,
				kodyId: page.kodyId,
				description:
					listing?.description ?? page.ownerPackage?.description ?? '',
				isPrivate: page.ownerPackage?.isPrivate ?? false,
				ownerProfilePublic: page.listing?.ownerProfilePublic ?? true,
				loggedIn: page.loggedIn,
				viewerIsOwner: page.viewerIsOwner,
				returnTo: url.pathname,
				publishCompareHref: await resolvePublishCompareHref({
					env,
					request,
					viewerIsOwner: page.viewerIsOwner,
					listing,
					packageId: page.ownerPackage?.id,
				}),
			})
		}

		const target = await resolveCommunityListingRoute({ env, url })
		// A frame never redirects: the page handler owns the visitor's URL, and
		// this content is only ever fetched for a URL it already resolved.
		if (target?.kind !== 'listing') {
			return ''
		}
		const detail = await loadCommunityDetailData(env, request, target.listingId)
		if (!detail) {
			return ''
		}
		return renderCommunityDetailContentHtml({
			listing: detail.listing,
			username: detail.listing?.ownerUsername ?? '',
			kodyId: detail.listing?.kodyId ?? '',
			description: detail.listing?.description ?? '',
			isPrivate: false,
			ownerProfilePublic: detail.ownerProfilePublic,
			loggedIn: detail.loggedIn,
			viewerIsOwner: detail.viewerIsOwner,
			returnTo: url.pathname,
			publishCompareHref: await resolvePublishCompareHref({
				env,
				request,
				viewerIsOwner: detail.viewerIsOwner,
				listing: detail.listing,
			}),
		})
	},
})
