import { html, type SafeHtml } from 'remix/html-template'
import { type PublicCommunityListing } from '#app/community-public-types.ts'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'

export { type PublicCommunityListing } from '#app/community-public-types.ts'

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

export function toPublicCommunityListing(
	listing: CommunityListingWithAggregates,
): PublicCommunityListing {
	return {
		id: listing.id,
		kodyId: listing.kodyId,
		name: listing.name,
		description: listing.description,
		tags: listing.tags,
		readmeContent: listing.readmeContent,
		license: listing.license,
		pinnedCommit: listing.pinnedCommit,
		publishedAt: listing.publishedAt,
		ownerUsername: getOwnerUsernameFromListingName(listing.name),
		averageStars: listing.averageStars,
		ratingCount: listing.ratingCount,
		averageAdaptationEffort: listing.averageAdaptationEffort,
		forkCount: listing.forkCount,
	}
}

export function buildCommunityIndexOgHead(): SafeHtml {
	return html`
		<meta property="og:title" content="Community packages — Kody" />
		<meta
			property="og:description"
			content="Browse community packages shared by Kody users."
		/>
		<meta property="og:type" content="website" />
		<meta name="twitter:card" content="summary" />
	`
}

export function buildCommunityDetailOgHead(input: {
	title: string
	description: string
	canonicalUrl: string
	ogImageUrl: string
}): SafeHtml {
	return html`
		<meta property="og:title" content="${input.title}" />
		<meta property="og:description" content="${input.description}" />
		<meta property="og:image" content="${input.ogImageUrl}" />
		<meta property="og:type" content="website" />
		<meta property="og:url" content="${input.canonicalUrl}" />
		<meta name="twitter:card" content="summary_large_image" />
		<meta name="twitter:title" content="${input.title}" />
		<meta name="twitter:description" content="${input.description}" />
		<meta name="twitter:image" content="${input.ogImageUrl}" />
		<link rel="canonical" href="${input.canonicalUrl}" />
	`
}

export function buildForkPrompt(input: { name: string; listingId: string }) {
	return `Use Kody to fork the community package "${input.name}" (listing id: ${input.listingId}). Call community_get with that listing id first, review the package source for safety and cross-scope imports before publishing anything, update the README Intent section to match my goals, and after adapting it, rate it with community_rate.`
}
