import {
	classifyForkListingRelation,
	type ForkListingRelation,
} from '#universal/community-listing-ahead.ts'
import { listingPinIsAncestorOfForkTip } from '#worker/community/fork-listing-ancestry.ts'
import { type SavedPackageWithCommunityProvenanceRecord } from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'

export function needsForkListingAncestry(input: {
	originCommit: string | null | undefined
	listingPinnedCommit: string | null | undefined
}) {
	return classifyForkListingRelation(input) === 'ahead'
}

export async function resolveListingPinAncestry(input: {
	env: Env
	sourceId: string
	listingPinnedCommit: string
	originCommit: string
}): Promise<boolean | null> {
	try {
		const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
		if (!source) return null
		const publishedCommit = source.published_commit?.trim() ?? ''
		const forkTip =
			publishedCommit.length > 0 ? publishedCommit : input.originCommit
		return await listingPinIsAncestorOfForkTip({
			env: input.env,
			repoId: source.repo_id,
			listingPinnedCommit: input.listingPinnedCommit,
			forkTip,
		})
	} catch {
		return null
	}
}

export async function applySavedPackageForkListingAncestry(input: {
	env: Env
	records: Array<SavedPackageWithCommunityProvenanceRecord>
}): Promise<Array<SavedPackageWithCommunityProvenanceRecord>> {
	if (input.records.length === 0) return input.records
	const ancestryBySourceId = new Map<string, Promise<boolean | null>>()
	function ancestryFor(record: SavedPackageWithCommunityProvenanceRecord) {
		if (
			record.listingCurrent !== true ||
			record.originCommit == null ||
			record.listingPinnedCommit == null ||
			!needsForkListingAncestry(record)
		) {
			return null
		}
		const existing = ancestryBySourceId.get(record.sourceId)
		if (existing) return existing
		const pending = resolveListingPinAncestry({
			env: input.env,
			sourceId: record.sourceId,
			listingPinnedCommit: record.listingPinnedCommit,
			originCommit: record.originCommit,
		})
		ancestryBySourceId.set(record.sourceId, pending)
		return pending
	}
	return Promise.all(
		input.records.map(async (record) => {
			const pending = ancestryFor(record)
			if (pending == null) {
				return withForkListingRelation(
					record,
					classifyForkListingRelation(record),
				)
			}
			return withForkListingRelation(
				record,
				classifyForkListingRelation({
					originCommit: record.originCommit,
					listingPinnedCommit: record.listingPinnedCommit,
					listingPinIsAncestorOfForkTip: await pending,
				}),
			)
		}),
	)
}

function withForkListingRelation(
	record: SavedPackageWithCommunityProvenanceRecord,
	relation: ForkListingRelation,
): SavedPackageWithCommunityProvenanceRecord {
	if (record.listingCurrent == null) return record
	if (record.listingCurrent !== true) {
		return {
			...record,
			listingAhead: false,
			forkListingRelation: null,
		}
	}
	return {
		...record,
		listingAhead: relation === 'outdated',
		forkListingRelation: relation,
	}
}
