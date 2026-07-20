import {
	type OnboardingFeaturedListing,
	type PublicCommunityActivityItem,
	type PublicCommunityListing,
	type PublicCommunityProfile,
	type PublicCommunityStargazer,
	type PublicProfilePackageItem,
} from '#app/community-public-types.ts'
import { routes } from '#app/routes.ts'
import { parseUserAvatarCacheKey } from '#worker/community/avatar.ts'
import {
	type CommunityActivityItem,
	type CommunityListingWithAggregates,
	type CommunityProfileRecord,
	type CommunityStargazer,
	type PublicProfilePackage,
} from '#worker/community/types.ts'

export {
	type OnboardingFeaturedListing,
	type PublicCommunityListing,
} from '#app/community-public-types.ts'

/**
 * Public payload mappers deliberately rebuild objects field-by-field so
 * internal identifiers (stable user ids, saved package ids) never serialize
 * into public JSON: stable user ids are unsalted email hashes and package
 * ids are the owner's private handles.
 */
export function buildUserAvatarUrl(input: {
	username: string
	avatarKey: string | null
}): string | null {
	if (!input.avatarKey) return null
	const cacheKey = parseUserAvatarCacheKey(input.avatarKey)
	if (!cacheKey) return null
	return routes.profileAvatar.href({
		username: input.username,
		cacheKey,
	})
}

export function toPublicCommunityProfile(
	profile: CommunityProfileRecord,
): PublicCommunityProfile {
	return {
		username: profile.username,
		displayName: profile.displayName,
		bio: profile.bio,
		avatarUrl: buildUserAvatarUrl({
			username: profile.username,
			avatarKey: profile.avatarKey,
		}),
		visibility: profile.visibility,
		joinedAt: profile.joinedAt,
		followerCount: profile.followerCount,
		followingCount: profile.followingCount,
		publicPackageCount: profile.publicPackageCount,
		listingCount: profile.listingCount,
	}
}

export function toPublicProfilePackageItem(
	pkg: PublicProfilePackage,
): PublicProfilePackageItem {
	return {
		name: pkg.name,
		kodyId: pkg.kodyId,
		description: pkg.description,
		tags: pkg.tags,
		updatedAt: pkg.updatedAt,
		communityListingId: pkg.communityListingId,
	}
}

export function toPublicCommunityActivityItem(
	item: CommunityActivityItem,
): PublicCommunityActivityItem {
	return {
		type: item.type,
		actorUsername: item.actorUsername,
		actorDisplayName: item.actorDisplayName,
		actorAvatarUrl: buildUserAvatarUrl({
			username: item.actorUsername,
			avatarKey: item.actorAvatarKey,
		}),
		listingId: item.listingId,
		listingName: item.listingName,
		listingKodyId: item.listingKodyId,
		createdAt: item.createdAt,
	}
}

export function toPublicCommunityStargazer(
	stargazer: CommunityStargazer,
): PublicCommunityStargazer {
	return {
		username: stargazer.username,
		displayName: stargazer.displayName,
		avatarUrl: buildUserAvatarUrl({
			username: stargazer.username,
			avatarKey: stargazer.avatarKey,
		}),
		starredAt: stargazer.starredAt,
	}
}

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
		starCount: listing.starCount,
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
