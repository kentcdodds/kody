import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { getSavedPackageById } from './repo.ts'
import {
	getPackageShareGrantById,
	PackageShareAccessError,
	type PackageShareGrantRow,
} from './share-grants.ts'
import {
	diffPublishedSourceFiles,
	pinAcknowledgeBlockedByTruncatedReview,
} from './share-diff.ts'

const truncatedPinAcknowledgeMessage =
	'Published source is truncated, so this pin cannot be approved without a complete review. Switch the grant to follow, or ask the owner to split the source.'

export async function assertSharePinAcknowledgeReview(input: {
	env: Env
	db: D1Database
	granteeUserId: string
	grantId: string
	packageId?: string
	switchToFollow?: boolean
}) {
	if (input.switchToFollow === true) return
	const grant = await getPackageShareGrantById(input.db, input.grantId)
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
	await assertGrantSnapshotsAllowPinAcknowledge({
		env: input.env,
		db: input.db,
		grant,
	})
}

async function assertGrantSnapshotsAllowPinAcknowledge(input: {
	env: Env
	db: D1Database
	grant: PackageShareGrantRow
}) {
	const acceptedCommit = input.grant.acceptedPublishedCommit
	if (!acceptedCommit) {
		throw new PackageShareAccessError(
			'This share grant has no published commits to compare.',
		)
	}
	const savedPackage = await getSavedPackageById(input.db, {
		userId: input.grant.ownerUserId,
		packageId: input.grant.packageId,
	})
	if (!savedPackage) {
		throw new PackageShareAccessError('Shared package was not found.')
	}
	const source = await getEntitySourceById(input.db, savedPackage.sourceId)
	const currentCommit = source?.published_commit ?? null
	if (!currentCommit) {
		throw new PackageShareAccessError(
			`Shared package ${savedPackage.name} has no published commit to approve.`,
		)
	}
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
	const files = diffPublishedSourceFiles(
		acceptedSnapshot.files,
		currentSnapshot.files,
	)
	if (pinAcknowledgeBlockedByTruncatedReview(files, false)) {
		throw new PackageShareAccessError(truncatedPinAcknowledgeMessage)
	}
}
