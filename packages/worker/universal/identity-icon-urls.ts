import { routes } from '#universal/routes.ts'

export function buildCommunityIconUrl(input: {
	listingId: string
	iconCommit: string
}) {
	return routes.communityDetailIcon.href(input)
}

export function buildPackageIdentityIconUrl(input: {
	username: string
	kodyId: string
	iconCommit: string
}) {
	return routes.communityPackageIcon.href(input)
}

export function buildRepoIdentityIconUrl(input: {
	repoId: string
	iconCommit: string
}) {
	return routes.accountRepoIcon.href(input)
}

export function resolvePackageListIconUrl(input: {
	username: string
	kodyId: string
	listingId: string | null
	listingIconCommit: string | null
	publishedCommit: string | null
}) {
	if (input.listingId && input.listingIconCommit) {
		return buildCommunityIconUrl({
			listingId: input.listingId,
			iconCommit: input.listingIconCommit,
		})
	}
	if (input.publishedCommit) {
		return buildPackageIdentityIconUrl({
			username: input.username,
			kodyId: input.kodyId,
			iconCommit: input.publishedCommit,
		})
	}
	return null
}
