/**
 * Public listing shape shared by server loaders/handlers and client routes.
 * Keep this module dependency-free so the client TypeScript project can
 * include it without pulling in server-only modules.
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
}
