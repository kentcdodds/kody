import { type PackageShareApproveChangesLoaderData } from '#universal/loader-data.ts'
import { diffPublishedSourceFiles } from '#app/package-share-diff.ts'
import {
	getPackageShareGrantById,
	requireHydratedPackageShareGrantView,
	PackageShareAccessError,
	toPackageShareGrantLoaderView,
} from '#worker/package-registry/share-grants.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'

export async function loadPackageShareApproveChangesData(input: {
	env: Env
	granteeUserId: string
	grantId?: string
	packageId?: string
}): Promise<PackageShareApproveChangesLoaderData> {
	const grant = input.grantId
		? await getPackageShareGrantById(input.env.APP_DB, input.grantId)
		: null
	if (
		!grant ||
		grant.granteeUserId !== input.granteeUserId ||
		grant.status !== 'accepted'
	) {
		throw new PackageShareAccessError(
			'Accepted share grant not found for a package shared with you.',
		)
	}
	if (input.packageId && grant.packageId !== input.packageId) {
		throw new PackageShareAccessError(
			'Share grant does not match this package.',
		)
	}
	const view = await requireHydratedPackageShareGrantView({
		db: input.env.APP_DB,
		grant,
	})
	const acceptedCommit = grant.acceptedPublishedCommit
	const currentCommit = view.publishedCommit
	if (!acceptedCommit || !currentCommit) {
		throw new PackageShareAccessError(
			'This share grant has no published commits to compare.',
		)
	}
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: grant.ownerUserId,
		packageId: grant.packageId,
	})
	if (!savedPackage) {
		throw new PackageShareAccessError('Shared package was not found.')
	}
	const source = await getEntitySourceById(
		input.env.APP_DB,
		savedPackage.sourceId,
	)
	const [acceptedSnapshot, currentSnapshot] = await Promise.all([
		readPublishedSourceSnapshot({
			env: input.env,
			sourceId: savedPackage.sourceId,
			publishedCommit: acceptedCommit,
		}),
		readPublishedSourceSnapshot({
			env: input.env,
			sourceId: source?.id ?? savedPackage.sourceId,
			publishedCommit: currentCommit,
		}),
	])
	if (!acceptedSnapshot || !currentSnapshot) {
		throw new PackageShareAccessError(
			'Published package source could not be loaded for comparison.',
		)
	}
	return {
		ok: true,
		grant: toPackageShareGrantLoaderView(view),
		acceptedCommit,
		currentCommit,
		files: diffPublishedSourceFiles(
			acceptedSnapshot.files,
			currentSnapshot.files,
		),
	}
}
