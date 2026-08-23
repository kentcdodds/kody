import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'

/**
 * Production featured zero-auth onboarding examples. Prefer matching live
 * featured listings by `zero-auth` tag; these ids only stabilize order and act
 * as a fallback identifier when tags are missing.
 */
export const onboardingExampleListingIds = [
	'f619713e-1a01-4fbf-91f2-03660d615832', // @kody/local-conditions
	'18f8977e-a001-4c83-bddd-f329eefc3f7c', // @kody/hn-pulse
	'bd541b8f-6c77-4a8d-9151-6e3b36afa069', // @kody/personal-capture
] as const

const onboardingExampleListingIdSet = new Set<string>(
	onboardingExampleListingIds,
)

export function isOnboardingExampleListing(listing: {
	id: string
	tags: Array<string>
}): boolean {
	return (
		listing.tags.includes('zero-auth') ||
		onboardingExampleListingIdSet.has(listing.id)
	)
}

/**
 * Featured zero-auth examples shown under onboarding Step 2 "Just try Kody".
 * Ordered like the known production set when present. Returns whatever the
 * featured payload includes; callers should tolerate an empty list when
 * curation has not landed yet.
 */
export function selectOnboardingExampleListings(
	featuredListings: Array<OnboardingFeaturedListing>,
): Array<OnboardingFeaturedListing> {
	const examples = featuredListings.filter(isOnboardingExampleListing)
	const knownIds = onboardingExampleListingIds as ReadonlyArray<string>
	return [...examples].sort((left, right) => {
		const leftIndex = knownIds.indexOf(left.id)
		const rightIndex = knownIds.indexOf(right.id)
		const leftRank = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex
		const rightRank = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex
		return leftRank - rightRank
	})
}

export function hasInstalledOnboardingExample(
	listings: Array<OnboardingFeaturedListing>,
): boolean {
	return selectOnboardingExampleListings(listings).some(
		(listing) => listing.viewerInstall != null,
	)
}

export function firstInstalledOnboardingExampleName(
	listings: Array<OnboardingFeaturedListing>,
): string | null {
	const installed = selectOnboardingExampleListings(listings).find(
		(listing) => listing.viewerInstall != null,
	)
	return installed?.viewerInstall?.targetName ?? installed?.name ?? null
}

/** Poll skip key for Just-try-Kody installs. */
export function onboardingExampleInstallFingerprint(
	listings: Array<OnboardingFeaturedListing>,
): string {
	return selectOnboardingExampleListings(listings)
		.map((listing) => `${listing.id}:${listing.viewerInstall?.status ?? ''}`)
		.join('|')
}

/** Featured starters under Step 3 Advanced: everything that is not a zero-auth example. */
export function selectOnboardingServiceStarterListings(
	featuredListings: Array<OnboardingFeaturedListing>,
): Array<OnboardingFeaturedListing> {
	return featuredListings.filter(
		(listing) => !isOnboardingExampleListing(listing),
	)
}

function exampleInvokeHint(scopedName: string, kodyId: string): string {
	const searchHint = `Search with search({ query: ${JSON.stringify(scopedName)} }) and inspect that user-owned package.`
	const specifier = `kody:${scopedName}`
	switch (kodyId) {
		case 'local-conditions':
			return `${searchHint} Example invoke: packages.invoke("${specifier}/getLocalConditions", { params: { place: "Salt Lake City" } }).`
		case 'hn-pulse':
			return `${searchHint} Example invoke: packages.invoke("${specifier}/getTopStories", { params: { limit: 5 } }).`
		case 'personal-capture':
			return `${searchHint} Example invoke: packages.invoke("${specifier}/capture", { params: { text: "Onboarding first build" } }), then packages.invoke("${specifier}/listCaptures", { params: { limit: 5 } }).`
		default:
			return `${searchHint} Call package_get for that installed package, read its README exports, then packages.invoke once with its scoped kody: module specifier.`
	}
}

/**
 * Agent paste after the user picks a Just-try-Kody example. Safe to show while
 * one-click install is still in flight — the agent is told to wait/retry once
 * if the fork is not searchable yet.
 */
export function buildOnboardingExamplePrompt(input: {
	listingName: string
	kodyId: string
	username: string
}): string {
	const scopedName = `@${input.username}/${input.kodyId}`
	return [
		`I started a one-click install/fork of the onboarding example "${input.listingName}" (kody id: ${input.kodyId}) into my Kody account.`,
		`Wait until that install is ready: search for my user-owned package by its scoped name "${scopedName}" once, and if it is missing, try again once after I say install finished — do not poll in a loop.`,
		`Then invoke MY installed/forked package with packages.invoke using its scoped specifier "kody:${scopedName}" (not a platform "kody:@kody/${input.kodyId}" specifier or bare @kody/* static import — those target the platform package, which cannot use my fork's packageStorage).`,
		exampleInvokeHint(scopedName, input.kodyId),
		'Show the result briefly. Explain that the package is one I own.',
		'Ask if I want to hang a trigger on it (webhook, Kody app, cron, or skip) — list options without recommending one.',
		'Keep messages short.',
	].join(' ')
}

export function buildOnboardingPackageAuthoringPrompt(kodyId: string): string {
	return [
		`Help me change my Kody package "${kodyId}" or create a new package.`,
		'First load coding_guide_get({ guide: "package_authoring" }) and coding_guide_get({ guide: "package_lifecycle" }).',
		`Then call package_get_git_remote({ create: true, kody_id: ${JSON.stringify(kodyId)} }) so we can work in the package repository.`,
		'Ask what I want the package to do, then follow the guides.',
	].join(' ')
}
