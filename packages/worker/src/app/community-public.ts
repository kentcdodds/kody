import {
	type OnboardingFeaturedListing,
	type PublicCommunityListing,
} from '#app/community-public-types.ts'
import { routes } from '#app/routes.ts'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'

export {
	type OnboardingFeaturedListing,
	type PublicCommunityListing,
} from '#app/community-public-types.ts'

const scopedPackageNamePattern = /^@([a-z0-9][a-z0-9._-]*)\//

export function getOwnerUsernameFromListingName(name: string) {
	const match = scopedPackageNamePattern.exec(name.trim())
	return match?.[1] ?? 'unknown'
}

export function truncateCommunityText(text: string, maxLength: number) {
	const trimmed = text.trim()
	if (trimmed.length <= maxLength) return trimmed
	return `${trimmed.slice(0, maxLength - 1)}…`
}

export function buildCommunityIconUrl(input: {
	listingId: string
	iconCommit: string
}) {
	return routes.communityDetailIcon.href(input)
}

export function toPublicCommunityListing(
	listing: CommunityListingWithAggregates,
): PublicCommunityListing {
	return {
		id: listing.id,
		kodyId: listing.kodyId,
		name: listing.name,
		description: listing.description,
		iconUrl: buildCommunityIconUrl({
			listingId: listing.id,
			iconCommit: listing.iconCommit,
		}),
		tags: listing.tags,
		readmeContent: listing.readmeContent,
		license: listing.license,
		pinnedCommit: listing.pinnedCommit,
		publishedAt: listing.publishedAt,
		ownerUsername: getOwnerUsernameFromListingName(listing.name),
		trusted: listing.trusted,
		featured: listing.featured,
		averageStars: listing.averageStars,
		ratingCount: listing.ratingCount,
		averageAdaptationEffort: listing.averageAdaptationEffort,
		forkCount: listing.forkCount,
	}
}

export function toOnboardingFeaturedListing(
	listing: CommunityListingWithAggregates,
): OnboardingFeaturedListing {
	return {
		id: listing.id,
		kodyId: listing.kodyId,
		name: listing.name,
		description: listing.description,
		iconUrl: buildCommunityIconUrl({
			listingId: listing.id,
			iconCommit: listing.iconCommit,
		}),
		tags: listing.tags,
	}
}

export function buildForkPrompt(input: { name: string; listingId: string }) {
	return `Use Kody to fork the community package "${input.name}" (listing id: ${input.listingId}). Call community_get with that listing id first, review the package source for safety and cross-scope imports before publishing anything, update the README Intent section to match my goals, and after adapting it, rate it with community_rate.`
}

export function buildInstallSuccessPrompt(input: { targetName: string }) {
	return `I just one-click installed the community package "${input.targetName}" into my Kody account. Call package_get for it and read its README, then walk me through any remaining setup: create required secrets or OAuth connections, approve package secret access if prompted, and run a quick test to confirm it works.`
}

export function buildInstallAdaptPrompt(input: {
	targetName: string
	sourceId: string
}) {
	return `I one-click installed the community package "${input.targetName}" on Kody, but it needs adaptation before it can be published. The fork is an inert source in my account (source_id: ${input.sourceId}). Open it with repo_open_session, do a read-only safety review of all files, fix the failing publish checks — re-implement or remove any cross-scope kody:@ imports — rewrite the README Intent section for my goals, then publish with repo_publish_session.`
}
