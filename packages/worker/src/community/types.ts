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
	createdAt: string
	updatedAt: string
	publishedAt: string
}

export type CommunityListingAggregates = {
	averageStars: number | null
	ratingCount: number
	averageAdaptationEffort: number | null
	forkCount: number
}

export type CommunityListingWithAggregates = CommunityListingRecord &
	CommunityListingAggregates

export type CommunityForkRow = {
	id: string
	listing_id: string
	forker_user_id: string
	origin_commit: string
	forked_package_id: string
	forked_source_id: string
	target_kody_id: string
	created_at: string
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
}

export type CommunityReportResolutionAction = 'dismiss' | 'delist' | 'delete'
