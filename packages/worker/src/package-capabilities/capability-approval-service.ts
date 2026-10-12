import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { computePackageCapabilitySet } from './compute-package-capability-set.ts'
import {
	findPackageCapabilityApprovalByFingerprint,
	getLatestPackageCapabilityApproval,
	insertPackageCapabilityApproval,
	type PackageCapabilityApprovalRecord,
} from './capability-approvals-repo.ts'
import {
	buildCapabilitySet,
	capabilitySetsEqual,
	type CapabilitySet,
} from './capability-set.ts'
import { updateSavedPackage } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'

export type CapabilityApprovalSummary = {
	capabilitySet: CapabilitySet
	publishedCommit: string | null
	latestApproval: PackageCapabilityApprovalRecord | null
	fingerprintMatchesApproval: boolean
	isInternetVisible: boolean
}

export async function loadCapabilityApprovalSummary(input: {
	env: Env
	ownerUserId: OwnerId
	savedPackage: SavedPackageRecord
	requestUrl: string
}): Promise<CapabilityApprovalSummary> {
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.savedPackage.sourceId,
	)
	const publishedCommit =
		source?.user_id === input.ownerUserId
			? (source.published_commit ?? null)
			: null

	const latestApproval = await getLatestPackageCapabilityApproval(
		input.env.APP_DB,
		{
			packageId: input.savedPackage.id,
			ownerUserId: input.ownerUserId,
		},
	)

	// Unpublished packages cannot load a published manifest. Return a
	// storage-only placeholder so the approval page / toggle can show
	// "publish first" instead of throwing.
	if (!publishedCommit) {
		const capabilitySet = await buildCapabilitySet([
			{
				kind: 'storage',
				storageId: input.savedPackage.id,
				hosts: [],
				via: [input.savedPackage.kodyId],
			},
		])
		return {
			capabilitySet,
			publishedCommit: null,
			latestApproval,
			fingerprintMatchesApproval: false,
			isInternetVisible: input.savedPackage.isInternetVisible,
		}
	}

	const capabilitySet = await computePackageCapabilitySet({
		env: input.env,
		ownerUserId: input.ownerUserId,
		packageId: input.savedPackage.id,
		packageKodyId: input.savedPackage.kodyId,
		sourceId: input.savedPackage.sourceId,
		requestUrl: input.requestUrl,
	})

	const matchingApproval = await findPackageCapabilityApprovalByFingerprint(
		input.env.APP_DB,
		{
			packageId: input.savedPackage.id,
			ownerUserId: input.ownerUserId,
			fingerprint: capabilitySet.fingerprint,
		},
	)

	return {
		capabilitySet,
		publishedCommit,
		latestApproval,
		fingerprintMatchesApproval: matchingApproval != null,
		isInternetVisible: input.savedPackage.isInternetVisible,
	}
}

export async function approvePackageCapabilitySet(input: {
	env: Env
	ownerUserId: OwnerId
	actorUserId: string
	savedPackage: SavedPackageRecord
	requestUrl: string
	/** Fingerprint the owner reviewed; must match the live set. */
	expectedFingerprint: string
	dependencySnapshotJson?: string
}): Promise<{
	approval: PackageCapabilityApprovalRecord
	capabilitySet: CapabilitySet
}> {
	const summary = await loadCapabilityApprovalSummary({
		env: input.env,
		ownerUserId: input.ownerUserId,
		savedPackage: input.savedPackage,
		requestUrl: input.requestUrl,
	})
	if (!summary.publishedCommit) {
		throw new CapabilityApprovalError(
			'Publish the package before approving internet-visible capabilities.',
		)
	}
	const expected = input.expectedFingerprint.trim()
	if (!expected) {
		throw new CapabilityApprovalError(
			'Reload the approval page and approve the current capability summary.',
		)
	}
	if (expected !== summary.capabilitySet.fingerprint) {
		throw new CapabilityApprovalError(
			'The capability set changed since you loaded this page. Reload, review the updated summary, and approve again.',
		)
	}

	const existing = await findPackageCapabilityApprovalByFingerprint(
		input.env.APP_DB,
		{
			packageId: input.savedPackage.id,
			ownerUserId: input.ownerUserId,
			fingerprint: summary.capabilitySet.fingerprint,
			publishedCommit: summary.publishedCommit,
		},
	)
	const now = new Date().toISOString()
	const approval =
		existing ??
		(await insertPackageCapabilityApproval(input.env.APP_DB, {
			id: crypto.randomUUID(),
			package_id: input.savedPackage.id,
			owner_user_id: input.ownerUserId,
			published_commit: summary.publishedCommit,
			fingerprint: summary.capabilitySet.fingerprint,
			capability_set_json: JSON.stringify(summary.capabilitySet.entries),
			dependency_snapshot_json: input.dependencySnapshotJson ?? '{}',
			approved_by_user_id: input.actorUserId,
			approved_at: now,
		}))

	if (!input.savedPackage.isInternetVisible) {
		const changed = await updateSavedPackage(input.env.APP_DB, {
			userId: input.ownerUserId,
			packageId: input.savedPackage.id,
			isInternetVisible: true,
		})
		if (!changed) {
			throw new CapabilityApprovalError('Package not found.')
		}
	}

	return { approval, capabilitySet: summary.capabilitySet }
}

export async function clearInternetVisible(input: {
	env: Env
	ownerUserId: OwnerId | string
	packageId: string
}): Promise<boolean> {
	return updateSavedPackage(input.env.APP_DB, {
		userId: input.ownerUserId,
		packageId: input.packageId,
		isInternetVisible: false,
	})
}

export function approvalMatchesCurrentSet(input: {
	currentFingerprint: string
	approval: PackageCapabilityApprovalRecord | null
}) {
	if (!input.approval) return false
	return capabilitySetsEqual(
		input.currentFingerprint,
		input.approval.fingerprint,
	)
}

export class CapabilityApprovalError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CapabilityApprovalError'
	}
}
