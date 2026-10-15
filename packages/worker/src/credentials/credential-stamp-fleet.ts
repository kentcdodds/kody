/**
 * Fleet scan/restamp for credential stamps (issue #3836 phase 2).
 *
 * dryRun (default) reports stamp presence and seal readiness across published
 * packages. Apply writes a stamp at the current published_commit only when the
 * package source is already seal-ready (every stamp key has a description and
 * no blocking gate failures). Packages that need manifest edits go through
 * codemod `0014-seal-credential-stamps`; packages with unconvertible patterns
 * are reported as `unconvertible` for an agent attempt then Kent notify.
 */
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { listSavedPackagesPage } from '#worker/package-registry/repo.ts'
import {
	loadPackageSourceBySourceId,
	loadPackageSourceRowForUser,
} from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { readPublishedCredentialStamp } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	planCredentialStampSeal,
	type CredentialStamp,
	type CredentialStampGateFailure,
} from './credential-stamp.ts'
import { storePublishedCredentialStamp } from './credential-stamp-store.ts'

export const credentialStampFleetScanPageSize = 50
export const credentialStampFleetScanLimitDefault = 50
export const credentialStampFleetScanLimitMax = 200
export const credentialStampFleetApplyLimitDefault = 5
export const credentialStampFleetApplyLimitMax = 10

export type CredentialStampFleetOutcome =
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: string
			stampKeyCount: number
			outcome:
				| 'stamped'
				| 'would_restamp'
				| 'restamped'
				| 'needs_manifest'
				| 'unconvertible'
	  }
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: null
			stampKeyCount: number
			outcome: 'skipped_unpublished'
	  }
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: string | null
			stampKeyCount: number
			outcome: 'failed'
			error: string
	  }

export type CredentialStampFleetResult = {
	dryRun: boolean
	scannedPackages: number
	publishedPackages: number
	stampedPackages: number
	missingStampPackages: number
	needsManifestPackages: number
	unconvertiblePackages: number
	restampedPackages: number
	failedPackages: number
	skippedUnpublished: number
	nextCursor: string | null
	outcomes: Array<CredentialStampFleetOutcome>
	/** Blocking failure codes seen on unconvertible packages this page. */
	unconvertibleFailureCodes: Array<CredentialStampGateFailure['code']>
}

function isCredentialStamp(value: unknown): value is CredentialStamp {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) {
		return false
	}
	const record = value as Record<string, unknown>
	return (
		record.version === 1 &&
		typeof record.stampHash === 'string' &&
		Array.isArray(record.keys) &&
		Array.isArray(record.depStamps)
	)
}

function matchesOptionalFilters(
	savedPackage: SavedPackageRecord,
	filters: {
		packageIds?: ReadonlySet<string>
		ownerUserIds?: ReadonlySet<string>
		sourceIds?: ReadonlySet<string>
	},
) {
	if (filters.packageIds && !filters.packageIds.has(savedPackage.id)) {
		return false
	}
	if (filters.ownerUserIds && !filters.ownerUserIds.has(savedPackage.userId)) {
		return false
	}
	if (filters.sourceIds && !filters.sourceIds.has(savedPackage.sourceId)) {
		return false
	}
	return true
}

async function listCandidatePackages(input: {
	env: Env
	afterId: string | null
	limit: number
	packageIds?: ReadonlySet<string>
	ownerUserIds?: ReadonlySet<string>
	sourceIds?: ReadonlySet<string>
}): Promise<{
	packages: Array<SavedPackageRecord>
	nextCursor: string | null
}> {
	const packages: Array<SavedPackageRecord> = []
	let cursor = input.afterId
	let pagesScanned = 0
	const maxPages = 20
	for (;;) {
		pagesScanned += 1
		const page = await listSavedPackagesPage(input.env.APP_DB, {
			afterId: cursor,
			limit: credentialStampFleetScanPageSize,
		})
		if (page.length === 0) {
			return { packages, nextCursor: null }
		}
		for (const savedPackage of page) {
			cursor = savedPackage.id
			if (!matchesOptionalFilters(savedPackage, input)) continue
			packages.push(savedPackage)
			if (packages.length >= input.limit) {
				return { packages, nextCursor: savedPackage.id }
			}
		}
		if (page.length < credentialStampFleetScanPageSize) {
			return { packages, nextCursor: null }
		}
		if (pagesScanned >= maxPages) {
			return { packages, nextCursor: cursor }
		}
	}
}

/**
 * Fleet scan/apply for published packages missing a complete credential stamp
 * at the current published commit. dryRun (default) reports only; apply
 * restamps seal-ready packages with no content change.
 */
export async function runCredentialStampFleet(input: {
	env: Env
	baseUrl: string
	dryRun?: boolean
	afterId?: string | null
	limit?: number
	packageIds?: ReadonlyArray<string>
	ownerUserIds?: ReadonlyArray<string>
	sourceIds?: ReadonlyArray<string>
}): Promise<CredentialStampFleetResult> {
	const dryRun = input.dryRun !== false
	const limit = Math.max(
		1,
		Math.min(
			input.limit ??
				(dryRun
					? credentialStampFleetScanLimitDefault
					: credentialStampFleetApplyLimitDefault),
			dryRun
				? credentialStampFleetScanLimitMax
				: credentialStampFleetApplyLimitMax,
		),
	)
	const packageIds = input.packageIds?.length
		? new Set(input.packageIds.map((id) => id.trim()).filter(Boolean))
		: undefined
	const ownerUserIds = input.ownerUserIds?.length
		? new Set(input.ownerUserIds.map((id) => id.trim()).filter(Boolean))
		: undefined
	const sourceIds = input.sourceIds?.length
		? new Set(input.sourceIds.map((id) => id.trim()).filter(Boolean))
		: undefined

	const { packages, nextCursor } = await listCandidatePackages({
		env: input.env,
		afterId: input.afterId ?? null,
		limit,
		packageIds,
		ownerUserIds,
		sourceIds,
	})

	const outcomes: Array<CredentialStampFleetOutcome> = []
	const unconvertibleFailureCodes = new Set<
		CredentialStampGateFailure['code']
	>()
	let publishedPackages = 0
	let stampedPackages = 0
	let missingStampPackages = 0
	let needsManifestPackages = 0
	let unconvertiblePackages = 0
	let restampedPackages = 0
	let failedPackages = 0
	let skippedUnpublished = 0

	for (const savedPackage of packages) {
		let publishedCommit: string | null = null
		try {
			const source = await loadPackageSourceRowForUser({
				env: input.env,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
			})
			publishedCommit = source.published_commit?.trim() || null
			if (!publishedCommit) {
				skippedUnpublished += 1
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit: null,
					stampKeyCount: 0,
					outcome: 'skipped_unpublished',
				})
				continue
			}
			publishedPackages += 1
			const loaded = await loadPackageSourceBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
			})
			const plan = planCredentialStampSeal(loaded.files)
			const stampKeyCount = plan.keys.length
			if (plan.blockingFailures.length > 0) {
				unconvertiblePackages += 1
				for (const failure of plan.blockingFailures) {
					unconvertibleFailureCodes.add(failure.code)
				}
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					stampKeyCount,
					outcome: 'unconvertible',
				})
				continue
			}
			if (plan.uninferableKeys.length > 0 || plan.updates.length > 0) {
				needsManifestPackages += 1
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					stampKeyCount,
					outcome: 'needs_manifest',
				})
				continue
			}
			const existing = await readPublishedCredentialStamp({
				env: input.env,
				sourceId: source.id,
				publishedCommit,
			})
			if (isCredentialStamp(existing)) {
				stampedPackages += 1
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					stampKeyCount,
					outcome: 'stamped',
				})
				continue
			}
			missingStampPackages += 1
			if (dryRun) {
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					stampKeyCount,
					outcome: 'would_restamp',
				})
				continue
			}
			const stored = await storePublishedCredentialStamp({
				env: input.env,
				source,
				publishedCommit,
				files: loaded.files,
			})
			if (stored == null) {
				throw new Error(
					`Failed to store credential stamp for source "${source.id}" at commit "${publishedCommit}".`,
				)
			}
			restampedPackages += 1
			outcomes.push({
				packageId: savedPackage.id,
				ownerUserId: savedPackage.userId,
				packageName: savedPackage.name,
				kodyId: savedPackage.kodyId,
				sourceId: savedPackage.sourceId,
				publishedCommit,
				stampKeyCount,
				outcome: 'restamped',
			})
		} catch (error) {
			failedPackages += 1
			outcomes.push({
				packageId: savedPackage.id,
				ownerUserId: savedPackage.userId,
				packageName: savedPackage.name,
				kodyId: savedPackage.kodyId,
				sourceId: savedPackage.sourceId,
				publishedCommit,
				stampKeyCount: 0,
				outcome: 'failed',
				error: getErrorMessage(error),
			})
		}
	}

	return {
		dryRun,
		scannedPackages: packages.length,
		publishedPackages,
		stampedPackages,
		missingStampPackages,
		needsManifestPackages,
		unconvertiblePackages,
		restampedPackages,
		failedPackages,
		skippedUnpublished,
		nextCursor,
		outcomes,
		unconvertibleFailureCodes: [...unconvertibleFailureCodes].sort(),
	}
}
