export type ViewerInstallListingRef = {
	id: string
	kodyId: string
}

export type ViewerInstallSavedPackage = {
	id: string
	kodyId: string
	name: string
	sourceId: string
}

export type ViewerInstallFork = {
	listingId: string
	targetKodyId: string
	forkedPackageId: string
	forkedSourceId: string
	createdAt: string
}

export type ResolvedViewerListingInstall = {
	status: 'installed' | 'adaptation_required'
	targetName: string
	sourceId: string
	/** Live saved package id when status is `installed`; otherwise null. */
	packageId: string | null
}

function compareCreatedAtDesc(left: string, right: string) {
	if (left === right) return 0
	return left > right ? -1 : 1
}

function scopedPackageName(packageScope: string, kodyId: string) {
	return `@${packageScope}/${kodyId}`
}

/**
 * Pick the viewer's existing install/fork for each listing.
 *
 * A saved package whose `kody_id` matches the listing wins (that is the
 * default one-click target, and a second install would collide). Otherwise
 * use a `community_forks` row for the listing: a live saved package for that
 * fork counts as installed; an inert source still needs adaptation.
 */
export function resolveViewerListingInstalls(input: {
	listings: Array<ViewerInstallListingRef>
	packageScope: string
	savedPackages: Array<ViewerInstallSavedPackage>
	forks: Array<ViewerInstallFork>
}): Map<string, ResolvedViewerListingInstall> {
	const savedByKodyId = new Map<string, ViewerInstallSavedPackage>()
	const savedById = new Map<string, ViewerInstallSavedPackage>()
	for (const savedPackage of input.savedPackages) {
		savedByKodyId.set(savedPackage.kodyId, savedPackage)
		savedById.set(savedPackage.id, savedPackage)
	}

	const forksByListingId = new Map<string, Array<ViewerInstallFork>>()
	for (const fork of input.forks) {
		const existing = forksByListingId.get(fork.listingId)
		if (existing) existing.push(fork)
		else forksByListingId.set(fork.listingId, [fork])
	}
	for (const forks of forksByListingId.values()) {
		forks.sort((left, right) =>
			compareCreatedAtDesc(left.createdAt, right.createdAt),
		)
	}

	const resolved = new Map<string, ResolvedViewerListingInstall>()
	for (const listing of input.listings) {
		const savedByKody = savedByKodyId.get(listing.kodyId)
		if (savedByKody) {
			resolved.set(listing.id, {
				status: 'installed',
				targetName: savedByKody.name,
				sourceId: savedByKody.sourceId,
				packageId: savedByKody.id,
			})
			continue
		}

		const listingForks = forksByListingId.get(listing.id)
		if (!listingForks || listingForks.length === 0) continue
		const matchingKodyFork = listingForks.find(
			(fork) => fork.targetKodyId === listing.kodyId,
		)
		const fork = matchingKodyFork ?? listingForks[0]
		if (!fork) continue
		const forkedSaved = savedById.get(fork.forkedPackageId)
		if (forkedSaved) {
			resolved.set(listing.id, {
				status: 'installed',
				targetName: forkedSaved.name,
				sourceId: forkedSaved.sourceId,
				packageId: forkedSaved.id,
			})
			continue
		}
		resolved.set(listing.id, {
			status: 'adaptation_required',
			targetName: scopedPackageName(input.packageScope, fork.targetKodyId),
			sourceId: fork.forkedSourceId,
			packageId: null,
		})
	}
	return resolved
}
