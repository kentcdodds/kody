/**
 * Signed-in viewer's existing fork/install of a community listing. Present
 * only on viewer-specific payloads (never cached with public listing rows).
 */
export type ViewerListingInstall = {
	status: 'installed' | 'adaptation_required'
	targetName: string
	agentPrompt: string
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
	readmeContent: string | null
	license: string
	pinnedCommit: string
	publishedAt: string
	ownerUsername: string
	/** True when an admin marked the current pinned commit as reviewed. */
	trusted: boolean
	/** True when an admin featured this trusted listing in onboarding. */
	featured: boolean
	averageStars: number | null
	ratingCount: number
	averageAdaptationEffort: number | null
	forkCount: number
	starCount: number
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
	followerCount: number
	followingCount: number
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
}

export type CommunityActivityEventType =
	| 'listing_published'
	| 'listing_updated'
	| 'listing_forked'
	| 'listing_starred'

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

export type PublicCommunityStargazer = {
	username: string
	displayName: string
	avatarUrl: string | null
	starredAt: string
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
