import { loadCommunityDetailData } from '#app/community-data.ts'
import { renderCommunityDetailContentHtml } from '#app/community-detail-content.tsx'
import { resolveCommunityListingRoute } from '#app/community-package-route.ts'
import { registerFrame } from '#app/frame-registry.ts'
import { loadPackagePage, packagePageIsPrivate } from '#app/package-page.ts'
import {
	buildPackageRepoActions,
	buildPackageRepoActionsForPage,
} from '#app/package-repo-actions.ts'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import { COMMUNITY_DETAIL_TARGET } from '#universal/community-frame-constants.ts'
import { routes } from '#universal/routes.ts'
import { createMatcher } from 'remix/route-pattern/match'

const communityPackageMatcher = createMatcher(routes.communityPackage.pattern)

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
				isPrivate: packagePageIsPrivate(page),
				ownerProfilePublic: page.ownerProfilePublic,
				viewerIsOwner: page.viewerIsOwner,
				viewerCanManage: page.viewerCanManage,
				viewerCanManageAccess: page.viewerCanManageAccess,
				repoActions: buildPackageRepoActionsForPage(page),
				hasPackage: page.hasPackage,
				packageShaped: page.packageShaped === true,
				iconUrl:
					listing?.iconUrl ??
					resolvePackageListIconUrl({
						username: page.username,
						kodyId: page.kodyId,
						listingId: null,
						listingIconCommit: null,
						publishedCommit: page.ownerPackage?.publishedCommit ?? null,
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
		const username = detail.listing?.ownerUsername ?? ''
		const kodyId = detail.listing?.kodyId ?? ''
		return renderCommunityDetailContentHtml({
			listing: detail.listing,
			username,
			kodyId,
			description: detail.listing?.description ?? '',
			isPrivate: false,
			ownerProfilePublic: detail.ownerProfilePublic,
			viewerIsOwner: detail.viewerIsOwner,
			viewerCanManage: detail.viewerCanManage,
			repoActions: buildPackageRepoActions({
				username,
				kodyId,
				listing: detail.listing,
				viewerInstall: detail.viewerInstall,
				viewerIsOwner: detail.viewerIsOwner,
				viewerCanManage: detail.viewerCanManage,
				loggedIn: detail.loggedIn,
				ownerPackage: detail.ownerPackage,
			}),
		})
	},
})
