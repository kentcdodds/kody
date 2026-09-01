import { type CommunityListingCategory } from '#universal/community-categories.ts'

/**
 * Signed-in viewer's existing fork/install of a community listing. Present
 * only on viewer-specific payloads (never cached with public listing rows).
 */
export type ViewerListingInstall = {
	status: 'installed' | 'adaptation_required'
	targetName: string
	agentPrompt: string
	/**
	 * Saved package id when the viewer has a live package for this listing.
	 * Null for inert forks that still need adaptation.
	 */
	packageId: string | null
	/**
	 * True when this viewer's fork last absorbed an older listing pin than
	 * the listing currently publishes.
	 */
	listingAhead: boolean
	/** Copyable agent prompt when `listingAhead` is true; otherwise null. */
	listingAheadPrompt: string | null
}

/**
 * Public listing shape shared by server loaders/handlers and client routes.
 * Keep this module dependency-free so it can live in the universal layer.
 */
export type PublicCommunityListing = {
	id: string
	kodyId: string
	name: string
	description: string
	iconUrl: string
	tags: Array<string>
	category: CommunityListingCategory
	readmeContent: string | null
	license: string
	pinnedCommit: string
	/**
	 * Git default-branch name for public `/tree/:ref` URLs. Omitted on cached
	 * catalog rows; the listing overlay sets it from artifact head lookup
	 * (`main` when lookup misses). Not `master` unless that is the repo default.
	 */
	defaultBranch?: string
	/** Default-branch HEAD SHA when it differs from the package runtime pin. */
	headCommit?: string | null
	/** True when default-branch HEAD is ahead of `pinnedCommit` (package publish). */
	sourceAhead?: boolean
	publishedAt: string
	ownerUsername: string
	/** Always false. Trusted listings were removed. */
	trusted: boolean
	/** True when an admin featured this listing in onboarding. */
	featured: boolean
	averageStars: number | null
	ratingCount: number
	averageAdaptationEffort: number | null
	forkCount: number
	/**
	 * Set only for signed-in viewers after a per-request overlay. Public
	 * listing cache rows omit this field.
	 */
	viewerInstall?: ViewerListingInstall | null
}

export type ProfileVisibility = 'public' | 'private'

export type PublicCommunityProfile = {
	username: string
	displayName: string
	bio: string | null
	avatarUrl: string | null
	visibility: ProfileVisibility
	joinedAt: string
	publicPackageCount: number
	listingCount: number
}

export type PublicProfilePackageItem = {
	name: string
	kodyId: string
	description: string
	tags: Array<string>
	updatedAt: string
	communityListingId: string | null
	/** The listing's `kody.id`, which can lag the package's until republish. */
	communityListingKodyId: string | null
	communityPublishedAt: string | null
	/** Present on the owner's own profile list; omitted for other viewers. */
	isPrivate?: boolean
	/** Present on the owner's own profile list; omitted for other viewers. */
	hidden?: boolean
}

export type CommunityActivityEventType =
	| 'listing_published'
	| 'listing_updated'
	| 'listing_forked'

export type PublicCommunityActivityItem = {
	type: CommunityActivityEventType
	actorUsername: string
	actorDisplayName: string
	actorAvatarUrl: string | null
	listingId: string
	listingName: string
	listingKodyId: string
	createdAt: string
}

/**
 * Slim listing shape embedded in the onboarding payload for the starter
 * package step. Kept minimal (no README) so onboarding stays light.
 */
export type OnboardingFeaturedListing = {
	id: string
	kodyId: string
	name: string
	description: string
	iconUrl: string
	tags: Array<string>
	/** Set only for signed-in viewers who already forked or installed this listing. */
	viewerInstall?: ViewerListingInstall | null
}
