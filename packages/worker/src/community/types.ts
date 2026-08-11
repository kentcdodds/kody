export type CommunityListingStatus = 'active' | 'delisted'

export type CommunityReportStatus = 'open' | 'resolved' | 'dismissed'

export type CommunityListingRow = {
	id: string
	owner_user_id: string
	package_id: string
	source_id: string
	kody_id: string
	name: string
	description: string
	tags_json: string
	search_text: string | null
	readme_content: string | null
	license: string
	pinned_commit: string
	status: CommunityListingStatus
	trusted_commit: string | null
	trusted_by_user_id: string | null
	trusted_at: string | null
	featured_at: string | null
	created_at: string
	updated_at: string
	published_at: string
}

export type CommunityListingRecord = {
	id: string
	ownerUserId: string
	packageId: string
	sourceId: string
	kodyId: string
	name: string
	description: string
	tags: Array<string>
	searchText: string | null
	readmeContent: string | null
	license: string
	pinnedCommit: string
	/**
	 * Commit the public listing icon is derived from: the owner package's
	 * current published commit when the listing's package source still
	 * exists, otherwise the pinned snapshot commit. Package publishes move
	 * this forward without a community republish, so icon URLs and cache
	 * keys bust as soon as a new `community-icon.*` is published.
	 */
	iconCommit: string
	status: CommunityListingStatus
	/**
	 * Commit an admin reviewed when marking this listing trusted, or null when
	 * never trusted (or trust was revoked). Trust follows the reviewed
	 * content: `trusted` is true only while this matches `pinnedCommit`, so an
	 * owner republish drops the effective mark until an admin re-reviews.
	 */
	trustedCommit: string | null
	trustedAt: string | null
	trusted: boolean
	/**
	 * When an admin marked this listing as an onboarding starter package, or
	 * null when never featured (or the mark was removed). The mark survives
	 * republishes, but the listing is only *effectively* featured while it is
	 * also effectively trusted, so `featured` drops with `trusted` and comes
	 * back if the same commit is re-trusted.
	 */
	featuredAt: string | null
	featured: boolean
	createdAt: string
	updatedAt: string
	publishedAt: string
}

export type CommunityListingAggregates = {
	averageStars: number | null
	ratingCount: number
	averageAdaptationEffort: number | null
	forkCount: number
	starCount: number
}

export type ProfileVisibility = 'public' | 'private'

export type CommunityProfileRecord = {
	userId: string
	username: string
	displayName: string
	bio: string | null
	avatarKey: string | null
	visibility: ProfileVisibility
	joinedAt: string
	followerCount: number
	followingCount: number
	publicPackageCount: number
	listingCount: number
}

export type CommunityActivityEventType =
	| 'listing_published'
	| 'listing_updated'
	| 'listing_forked'
	| 'listing_starred'

export type CommunityActivityItem = {
	type: CommunityActivityEventType
	actorUserId: string
	actorUsername: string
	actorDisplayName: string
	actorAvatarKey: string | null
	listingId: string
	listingName: string
	listingKodyId: string
	createdAt: string
}

export type PublicProfilePackage = {
	packageId: string
	name: string
	kodyId: string
	description: string
	tags: Array<string>
	updatedAt: string
	communityListingId: string | null
	/**
	 * The listing's own `kody_id`, which only moves on republish and so can lag
	 * the package's. Public links have to use this one to stay resolvable.
	 */
	communityListingKodyId: string | null
	/** published_at of the active community listing, when the package has one. */
	communityPublishedAt: string | null
}

export type CommunityStargazer = {
	userId: string
	username: string
	displayName: string
	avatarKey: string | null
	starredAt: string
}

export type CommunityListingWithAggregates = CommunityListingRecord &
	CommunityListingAggregates

export type CommunityListingSearchResult = CommunityListingWithAggregates & {
	relevance: number | null
}

export const communityActivityKinds = ['fork', 'rating'] as const

export type CommunityActivityKind = (typeof communityActivityKinds)[number]

type CommunityActivityRecordBase = {
	id: string
	listingId: string
	listingName: string
	listingKodyId: string
	actingUsername: string | null
	occurredAt: string
}

export type CommunityActivityRecord =
	| (CommunityActivityRecordBase & {
			kind: 'fork'
	  })
	| (CommunityActivityRecordBase & {
			kind: 'rating'
			stars: number
			adaptationEffort: number
	  })

/**
 * Who caused a fork: a person clicking install in the web app, or that
 * person's agent calling `community_fork` over MCP. Null on rows created
 * before the distinction was recorded.
 */
export type CommunityForkActor = 'human' | 'agent'

export type CommunityForkRow = {
	id: string
	listing_id: string
	forker_user_id: string
	origin_commit: string
	forked_package_id: string
	forked_source_id: string
	target_kody_id: string
	created_at: string
	adopted_at: string | null
	adoption_note: string | null
	actor: CommunityForkActor | null
}

export type CommunityForkRecord = {
	id: string
	listingId: string
	forkerUserId: string
	originCommit: string
	forkedPackageId: string
	forkedSourceId: string
	targetKodyId: string
	createdAt: string
	adoptedAt: string | null
	adoptionNote: string | null
}

export type CommunityRatingRow = {
	id: string
	listing_id: string
	user_id: string
	stars: number
	adaptation_effort: number
	note: string | null
	created_at: string
	updated_at: string
}

export type CommunityRatingRecord = {
	id: string
	listingId: string
	userId: string
	stars: number
	adaptationEffort: number
	note: string | null
	createdAt: string
	updatedAt: string
}

export type CommunityRatingAggregate = {
	listingId: string
	averageStars: number | null
	ratingCount: number
	averageAdaptationEffort: number | null
}

export type CommunityReportRow = {
	id: string
	listing_id: string
	listing_name: string
	listing_owner_user_id: string
	reporter_user_id: string
	reason: string
	status: CommunityReportStatus
	resolved_by_user_id: string | null
	resolved_at: string | null
	resolution_note: string | null
	created_at: string
	updated_at: string
}

export type CommunityReportRecord = {
	id: string
	listingId: string
	listingName: string
	listingOwnerUserId: string
	reporterUserId: string
	reason: string
	status: CommunityReportStatus
	resolvedByUserId: string | null
	resolvedAt: string | null
	resolutionNote: string | null
	createdAt: string
	updatedAt: string
}

export type CommunityBanRow = {
	user_id: string
	banned_by_user_id: string
	reason: string
	created_at: string
}

export type CommunityBanRecord = {
	userId: string
	bannedByUserId: string
	reason: string
	createdAt: string
}

export type CommunitySnapshot = {
	version: 1
	listingId: string
	pinnedCommit: string
	files: Record<string, string>
	communityIconPath?: string | null
	createdAt: string
}

export type CrossScopeReference = {
	file: string
	specifier: string
}

export type ForkCommunityListingResult = {
	forkId: string
	packageId: string
	sourceId: string
	targetKodyId: string
	targetName: string
	originCommit: string
	crossScopeReferences: Array<CrossScopeReference>
	filesCount: number
	/**
	 * The rewritten snapshot files that were synced into the fork's source.
	 * One-click install runs publish checks against these without re-reading
	 * the snapshot; capability results must never expose them directly.
	 */
	files: Record<string, string>
}

export type CommunityReportResolutionAction = 'dismiss' | 'delist' | 'delete'
