import { type Action } from 'remix/router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	identityIconNotFound,
	serveIdentityIcon,
} from './identity-icon-response.ts'
import { resolvePackagePageUrl } from '#worker/community/package-url.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { loadViewerPackageShare } from '#worker/package-registry/share-grants.ts'
import { type routes } from '#universal/routes.ts'

function isGuestVisiblePackage(pkg: { hidden: boolean; isPrivate: boolean }) {
	return !pkg.hidden && !pkg.isPrivate
}

export function createCommunityPackageIconHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const [target, user] = await Promise.all([
				resolvePackagePageUrl({
					db: env.APP_DB,
					username: params.username,
					kodyId: params.kodyId,
				}),
				readAuthenticatedAppUser(request, env),
			])
			if (!target || target.kind === 'redirect' || !target.savedPackage) {
				return identityIconNotFound()
			}

			const viewerUserId = user?.mcpUser.userId ?? null
			const viewerIsOwner = viewerUserId === target.userId
			const shareGrant = viewerIsOwner
				? null
				: await loadViewerPackageShare({
						db: env.APP_DB,
						packageId: target.savedPackage.id,
						viewer: user
							? {
									userId: user.mcpUser.userId,
									email: user.email,
									emailVerified: user.emailVerified,
								}
							: null,
					})
			const shareCanRead = shareGrant?.status === 'accepted'
			const listing = target.listingId
				? await getCommunityListingById(env.APP_DB, {
						listingId: target.listingId,
						includeDelisted: false,
					})
				: null
			const guestVisible =
				Boolean(listing) || isGuestVisiblePackage(target.savedPackage)
			if (!viewerIsOwner && !shareCanRead && !guestVisible) {
				return identityIconNotFound()
			}

			const source = await getEntitySourceById(
				env.APP_DB,
				target.savedPackage.sourceId,
			)
			if (
				!source ||
				source.user_id !== target.userId ||
				source.entity_kind !== 'package'
			) {
				return identityIconNotFound()
			}

			const publishedCommit = source.published_commit
			const listingCommits = listing
				? [listing.iconCommit, listing.pinnedCommit]
				: []
			const allowedCommits = [publishedCommit, ...listingCommits].filter(
				(commit): commit is string => Boolean(commit),
			)
			if (!allowedCommits.includes(params.iconCommit)) {
				return identityIconNotFound()
			}

			return await serveIdentityIcon({
				env,
				repoId: source.repo_id,
				iconCommit: params.iconCommit,
				ownerUserId: target.userId,
				leafName: target.savedPackage.kodyId,
				includePackageAppIcon: true,
				isServableCommit: async () => {
					const current = await getEntitySourceById(env.APP_DB, source.id)
					if (
						!current ||
						current.user_id !== target.userId ||
						current.entity_kind !== 'package'
					) {
						return false
					}
					const currentListing = target.listingId
						? await getCommunityListingById(env.APP_DB, {
								listingId: target.listingId,
								includeDelisted: false,
							})
						: null
					return (
						params.iconCommit === current.published_commit ||
						params.iconCommit === currentListing?.iconCommit ||
						params.iconCommit === currentListing?.pinnedCommit
					)
				},
				logLabel: 'package-identity-icon',
			})
		},
	} satisfies Action<typeof routes.communityPackageIcon>
}
