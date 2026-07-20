import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { getCommunityListingByOwnerAndPackage } from '#worker/community/repo.ts'
import { publishCommunityListing } from '#worker/community/service.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { rewritePackageFilesForUsernameChange } from '#worker/package-registry/username-scope-rewrite.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'

export type UsernameChangePackageUpdate = {
	packageId: string
	kodyId: string
	previousName: string | null
	nextName: string
	publishedCommit: string | null
	changedPaths: Array<string>
	shouldRepublishCommunityListing: boolean
}

export type UsernameChangePackagesResult = {
	updatedPackages: Array<UsernameChangePackageUpdate>
	skippedPackages: Array<{ packageId: string; kodyId: string; reason: string }>
}

function buildUsernameRenameCommitMessage(input: {
	previousScope: string
	nextScope: string
}) {
	return `Rename package scope after username change from @${input.previousScope} to @${input.nextScope}`
}

async function rewriteAndPublishPackageScope(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceId: string
	files: Record<string, string>
	previousScope: string
	nextScope: string
	kodyId: string
	packageId: string
}): Promise<UsernameChangePackageUpdate | null> {
	const rewrite = rewritePackageFilesForUsernameChange({
		files: input.files,
		previousScope: input.previousScope,
		nextScope: input.nextScope,
		kodyId: input.kodyId,
	})
	if (!rewrite.changed) {
		return null
	}

	// Pass the full rewritten tree. Partial file maps are unsafe on the
	// unpublished bootstrap path in syncArtifactSourceSnapshot, which replaces
	// the whole repo with only the provided files.
	const publishedCommit = await syncArtifactSourceSnapshot({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.sourceId,
		files: rewrite.files,
		expectedPackageScope: input.nextScope,
		destructiveOverwriteConfirmed: true,
		commitMessage: buildUsernameRenameCommitMessage({
			previousScope: input.previousScope,
			nextScope: input.nextScope,
		}),
	})

	try {
		await refreshSavedPackageProjection({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			packageId: input.packageId,
			sourceId: input.sourceId,
		})
	} catch (error) {
		// Publish already succeeded; keep this package in the applied set so
		// callers can compensate. Projection can be repaired on the next save.
		console.error(
			JSON.stringify({
				message: 'username-change package projection refresh failed',
				packageId: input.packageId,
				error: getErrorMessage(error),
			}),
		)
	}

	return {
		packageId: input.packageId,
		kodyId: input.kodyId,
		previousName: rewrite.previousName,
		nextName: rewrite.nextName,
		publishedCommit,
		changedPaths: rewrite.changedPaths,
		shouldRepublishCommunityListing: false,
	}
}

async function compensatePackageUpdates(input: {
	env: Env
	baseUrl: string
	userId: string
	previousScope: string
	nextScope: string
	applied: Array<{
		packageId: string
		sourceId: string
		filesAtNewScope: Record<string, string>
		kodyId: string
	}>
}) {
	for (const applied of [...input.applied].reverse()) {
		try {
			await rewriteAndPublishPackageScope({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceId: applied.sourceId,
				files: applied.filesAtNewScope,
				previousScope: input.nextScope,
				nextScope: input.previousScope,
				kodyId: applied.kodyId,
				packageId: applied.packageId,
			})
		} catch (compensateError) {
			console.error(
				JSON.stringify({
					message: 'username-change package compensation failed',
					packageId: applied.packageId,
					error: getErrorMessage(compensateError),
				}),
			)
		}
	}
}

/**
 * Rewrite and republish every saved package whose scope still embeds the
 * previous username. Call this **after** claiming `users.username` so the
 * new scope is reserved before package publishes. Package publish validates
 * against `nextUsername` via `expectedPackageScope`.
 *
 * Returns which updated packages had an active community listing already
 * pinned to the pre-rename published commit; the caller should republish
 * those listings after this returns.
 */
export async function updatePackagesForUsernameChange(input: {
	env: Env
	baseUrl: string
	userId: string
	previousUsername: string
	nextUsername: string
}): Promise<UsernameChangePackagesResult> {
	const previousScope = input.previousUsername.trim().toLowerCase()
	const nextScope = input.nextUsername.trim().toLowerCase()
	if (!previousScope || previousScope === nextScope) {
		return {
			updatedPackages: [],
			skippedPackages: [],
		}
	}

	const savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
		userId: input.userId,
	})
	const updatedPackages: Array<UsernameChangePackageUpdate> = []
	const skippedPackages: Array<{
		packageId: string
		kodyId: string
		reason: string
	}> = []
	const applied: Array<{
		packageId: string
		sourceId: string
		filesAtNewScope: Record<string, string>
		kodyId: string
	}> = []

	try {
		for (const savedPackage of savedPackages) {
			const loaded = await loadPackageSourceBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceId: savedPackage.sourceId,
			})

			const listing = await getCommunityListingByOwnerAndPackage(
				input.env.APP_DB,
				{
					ownerUserId: input.userId,
					packageId: savedPackage.id,
				},
			)
			const shouldRepublishCommunityListing =
				listing != null &&
				listing.status === 'active' &&
				loaded.source.published_commit != null &&
				listing.pinnedCommit === loaded.source.published_commit

			const rewrite = rewritePackageFilesForUsernameChange({
				files: loaded.files,
				previousScope,
				nextScope,
				kodyId: savedPackage.kodyId,
			})
			if (!rewrite.changed) {
				skippedPackages.push({
					packageId: savedPackage.id,
					kodyId: savedPackage.kodyId,
					reason: 'already_new_scope',
				})
				continue
			}

			const update = await rewriteAndPublishPackageScope({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceId: savedPackage.sourceId,
				files: loaded.files,
				previousScope,
				nextScope,
				kodyId: savedPackage.kodyId,
				packageId: savedPackage.id,
			})
			if (!update) {
				skippedPackages.push({
					packageId: savedPackage.id,
					kodyId: savedPackage.kodyId,
					reason: 'already_new_scope',
				})
				continue
			}

			applied.push({
				packageId: savedPackage.id,
				sourceId: savedPackage.sourceId,
				filesAtNewScope: rewrite.files,
				kodyId: savedPackage.kodyId,
			})
			updatedPackages.push({
				...update,
				shouldRepublishCommunityListing,
			})
		}
	} catch (error) {
		await compensatePackageUpdates({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			previousScope,
			nextScope,
			applied,
		})
		throw error
	}

	return {
		updatedPackages,
		skippedPackages,
	}
}

/**
 * Republish community listings that were already on the package's latest
 * commit before the username-rename package publishes. Safe to call after
 * `users.username` has been updated.
 */
export async function republishCommunityListingsAfterUsernameChange(input: {
	env: Env
	baseUrl: string
	userId: string
	packageIds: Array<string>
}): Promise<{
	republishedPackageIds: Array<string>
	warnings: Array<string>
}> {
	const republishedPackageIds: Array<string> = []
	const warnings: Array<string> = []
	for (const packageId of input.packageIds) {
		try {
			await publishCommunityListing({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				packageId,
			})
			republishedPackageIds.push(packageId)
		} catch (error) {
			warnings.push(
				`Community listing for package "${packageId}" was not republished: ${getErrorMessage(error)}`,
			)
		}
	}
	return { republishedPackageIds, warnings }
}
