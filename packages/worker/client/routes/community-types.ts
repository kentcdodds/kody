export type PublicCommunityListing = {
	id: string
	kodyId: string
	name: string
	description: string
	tags: Array<string>
	readmeContent: string | null
	license: string
	pinnedCommit: string
	publishedAt: string
	ownerUsername: string
	averageStars: number | null
	ratingCount: number
	averageAdaptationEffort: number | null
	forkCount: number
}
