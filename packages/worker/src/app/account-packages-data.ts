import {
	buildForkListingDiffHref,
	buildListingAheadPrompt,
} from '#universal/community-listing-ahead.ts'
import { getCommunityListingHref } from '#universal/community-links.ts'
import {
	type AccountPackageDetail,
	type AccountPackageListItem,
	type AccountPackageForkAhead,
	type AccountPackageListingAhead,
	type AccountPackagesAppFilter,
	type AccountPackagesLoaderData,
	type AccountPackagesSort,
} from '#universal/loader-data.ts'
import {
	creditAttributionForPackage,
	type CreditAttributionRow,
} from '#universal/credit-attribution.ts'
import { listPackageManifestExportNames } from '#universal/package-export-selection.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { readAccountComputeOverage } from '#worker/billing/compute-overage-account.ts'
import {
	resolveUserEntitlementFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { loadCreditAttributionBreakdown } from '#worker/usage/credit-attribution.ts'
import { routes } from '#universal/routes.ts'
import { readPagination } from '#worker/query-params.ts'
import { recordServerTiming } from '#worker/request-context.ts'
import {
	getCommunityForkByForkedPackageId,
	getCommunityListingByOwnerAndPackage,
} from '#worker/community/repo.ts'
import {
	getSavedPackageWithCommunityProvenanceById,
	resolveSavedPackageRefWithCommunityProvenance,
	listSavedPackageCommunityProvenanceByIds,
	searchSavedPackagesByUserId,
} from '#worker/package-registry/repo.ts'
import { applySavedPackageForkListingAncestry } from '#worker/community/fork-listing-relation.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import {
	type SavedPackageRecord,
	type SavedPackageWithCommunityProvenanceRecord,
} from '#worker/package-registry/types.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

const accountPackagesBasePath = '/account/packages'
const defaultPageSize = 20
const maxPageSize = 100

export function readAccountPackagesSelectedPackageId(
	requestUrl: string,
	pathPackageId?: string,
) {
	if (pathPackageId?.trim()) return pathPackageId.trim()
	const url = new URL(requestUrl, 'http://localhost')
	const detailPrefix = `${accountPackagesBasePath}/`
	if (url.pathname.startsWith(detailPrefix)) {
		const packageId = decodeURIComponent(
			url.pathname.slice(detailPrefix.length),
		)
		if (packageId) return packageId
	}
	const selected = url.searchParams.get('selected')?.trim()
	return selected ? selected : null
}

function readAppFilter(url: URL): AccountPackagesAppFilter {
	const raw = url.searchParams.get('app')?.trim()
	return raw === 'with' || raw === 'without' ? raw : 'all'
}

function readSort(url: URL): AccountPackagesSort {
	const raw = url.searchParams.get('sort')?.trim()
	return raw === 'created' || raw === 'name' ? raw : 'updated'
}

function appFilterToHasApp(appFilter: AccountPackagesAppFilter) {
	switch (appFilter) {
		case 'all':
			return null
		case 'with':
			return true
		case 'without':
			return false
		default:
			appFilter satisfies never
			return null
	}
}

function toListingAhead(
	record: SavedPackageWithCommunityProvenanceRecord,
): AccountPackageListingAhead | null {
	if (
		!record.listingAhead ||
		record.sourceListingId == null ||
		record.listingName == null ||
		record.originCommit == null ||
		record.listingPinnedCommit == null
	) {
		return null
	}
	return {
		listingId: record.sourceListingId,
		listingName: record.listingName,
		listingHref: getCommunityListingHref({
			listingId: record.sourceListingId,
			listingName: record.listingName,
			kodyId: record.listingKodyId,
		}),
		originCommit: record.originCommit,
		listingPinnedCommit: record.listingPinnedCommit,
		listingPublishedAt: record.listingPublishedAt,
		prompt: buildListingAheadPrompt({
			listingName: record.listingName,
			listingId: record.sourceListingId,
			listingKodyId: record.listingKodyId,
			packageName: record.name,
			packageId: record.id,
			sourceId: record.sourceId,
			originCommit: record.originCommit,
			listingPinnedCommit: record.listingPinnedCommit,
		}),
		diffHref: buildForkListingDiffHref({
			listingId: record.sourceListingId,
			listingName: record.listingName,
			listingKodyId: record.listingKodyId,
			listingPinnedCommit: record.listingPinnedCommit,
		}),
	}
}

function toForkAhead(
	record: SavedPackageWithCommunityProvenanceRecord,
): AccountPackageForkAhead | null {
	if (
		record.forkListingRelation !== 'ahead' ||
		record.sourceListingId == null ||
		record.listingName == null ||
		record.listingPinnedCommit == null
	) {
		return null
	}
	return {
		listingId: record.sourceListingId,
		listingName: record.listingName,
		listingHref: getCommunityListingHref({
			listingId: record.sourceListingId,
			listingName: record.listingName,
			kodyId: record.listingKodyId,
		}),
		diffHref: buildForkListingDiffHref({
			listingId: record.sourceListingId,
			listingName: record.listingName,
			listingKodyId: record.listingKodyId,
			listingPinnedCommit: record.listingPinnedCommit,
		}),
	}
}

function toListItem(
	record: SavedPackageRecord,
	listingAhead: AccountPackageListingAhead | null = null,
	forkAhead: AccountPackageForkAhead | null = null,
): AccountPackageListItem {
	return {
		id: record.id,
		name: record.name,
		kodyId: record.kodyId,
		description: record.description,
		tags: record.tags,
		hasApp: record.hasApp,
		sourceId: record.sourceId,
		lockedAt: record.lockedAt,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		hidden: record.hidden,
		isPrivate: record.isPrivate,
		hasCommunityListing: false,
		listingAhead,
		forkAhead,
	}
}

async function loadPackageExportNames(input: {
	env: Env
	requestUrl: string
	userId: string
	sourceId: string
}): Promise<Array<string> | null> {
	try {
		const loaded = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: getAppBaseUrl({
				env: input.env,
				requestUrl: input.requestUrl,
			}),
			userId: input.userId,
			sourceId: input.sourceId,
		})
		return listPackageManifestExportNames(loaded.manifest.exports)
	} catch {
		return null
	}
}

async function toDetail(input: {
	env: Env
	requestUrl: string
	userId: string
	username?: string
	record: SavedPackageWithCommunityProvenanceRecord
	hasCommunityListing: boolean
}): Promise<AccountPackageDetail> {
	const [exports, source, communityFork, creditAttribution] = await Promise.all(
		[
			loadPackageExportNames({
				env: input.env,
				requestUrl: input.requestUrl,
				userId: input.userId,
				sourceId: input.record.sourceId,
			}),
			getEntitySourceById(input.env.APP_DB, input.record.sourceId),
			input.record.sourceListingId == null
				? Promise.resolve(null)
				: getCommunityForkByForkedPackageId(input.env.APP_DB, {
						forkerUserId: input.userId,
						forkedPackageId: input.record.id,
					}),
			loadPackageCreditAttributionRow({
				env: input.env,
				stableUserId: input.userId,
				username: input.username ?? '',
				packageId: input.record.id,
			}),
		],
	)
	return {
		...toListItem(
			input.record,
			toListingAhead(input.record),
			toForkAhead(input.record),
		),
		hasCommunityListing: input.hasCommunityListing,
		searchText: input.record.searchText,
		exports,
		publishedCommit:
			source?.user_id === input.userId
				? (source.published_commit ?? null)
				: null,
		communityFork: communityFork
			? {
					listingName: input.record.listingName,
					adoptedAt: communityFork.adoptedAt,
					adoptionNote: communityFork.adoptionNote,
				}
			: null,
		creditAttribution,
	}
}

async function loadPackageCreditAttributionRow(input: {
	env: Env
	stableUserId: string
	username: string
	packageId: string
}): Promise<CreditAttributionRow | null> {
	if (!input.username.trim()) return null
	if (typeof input.env.APP_DB?.prepare !== 'function') return null
	try {
		const userRow = await input.env.APP_DB.prepare(
			`SELECT ${userEntitlementColumnsSql()}
			 FROM users WHERE stable_user_id = ?`,
		)
			.bind(input.stableUserId)
			.first<UserEntitlementRow>()
		if (!userRow) return null
		const now = new Date()
		const entitlement = await resolveUserEntitlementFromRow({
			db: input.env.APP_DB,
			stableUserId: input.stableUserId,
			row: userRow,
			now,
		})
		const computeOverage = await readAccountComputeOverage({
			db: input.env.APP_DB,
			stableUserId: input.stableUserId,
			plan: entitlement.plan,
			ladder: entitlement.ladder,
			creditWallet: entitlement.creditWallet,
			now,
		})
		const breakdown = await loadCreditAttributionBreakdown({
			db: input.env.APP_DB,
			stableUserId: input.stableUserId,
			username: input.username,
			computeOverage,
			now,
		})
		const attribution = creditAttributionForPackage(breakdown, input.packageId)
		if (!attribution) return null
		if (
			attribution.name === input.packageId ||
			attribution.name === attribution.packageId
		) {
			const saved = await input.env.APP_DB.prepare(
				`SELECT kody_id, name FROM saved_packages WHERE id = ? AND user_id = ?`,
			)
				.bind(input.packageId, input.stableUserId)
				.first<{ kody_id: string; name: string }>()
			if (saved) {
				attribution.name = saved.name?.trim() || saved.kody_id
				attribution.href = routes.communityPackage.href({
					username: input.username,
					kodyId: saved.kody_id,
				})
			}
		}
		return attribution
	} catch (error) {
		console.warn('package-credit-attribution-load-failed', error)
		return null
	}
}

async function hasActiveCommunityListing(input: {
	db: D1Database
	userId: string
	packageId: string
}) {
	const listing = await getCommunityListingByOwnerAndPackage(input.db, {
		ownerUserId: input.userId,
		packageId: input.packageId,
	})
	return listing?.status === 'active'
}

export async function loadAccountPackageDetail(input: {
	env: Env
	requestUrl: string
	userId: string
	/** Owner username; required to load credit attribution on the package page. */
	username?: string
	packageId?: string
	kodyId?: string
}): Promise<AccountPackageDetail | null> {
	const record = input.kodyId
		? await resolveSavedPackageRefWithCommunityProvenance(input.env.APP_DB, {
				userId: input.userId,
				ref: input.kodyId,
				match: 'slug',
			})
		: input.packageId
			? await getSavedPackageWithCommunityProvenanceById(input.env.APP_DB, {
					userId: input.userId,
					packageId: input.packageId,
				})
			: null
	if (!record) return null
	const [enriched] = await applySavedPackageForkListingAncestry({
		env: input.env,
		records: [record],
	})
	if (!enriched) return null
	return recordServerTiming('owner-package', () =>
		toDetailWithListingState({
			env: input.env,
			requestUrl: input.requestUrl,
			userId: input.userId,
			username: input.username,
			record: enriched,
		}),
	)
}

/**
 * The listing lookup and the detail reads (manifest, source row) are
 * independent D1/KV round trips; run them together.
 */
async function toDetailWithListingState(input: {
	env: Env
	requestUrl: string
	userId: string
	username?: string
	record: SavedPackageWithCommunityProvenanceRecord
}): Promise<AccountPackageDetail> {
	const [hasCommunityListing, detail] = await Promise.all([
		hasActiveCommunityListing({
			db: input.env.APP_DB,
			userId: input.userId,
			packageId: input.record.id,
		}),
		toDetail({
			env: input.env,
			requestUrl: input.requestUrl,
			userId: input.userId,
			username: input.username,
			record: input.record,
			hasCommunityListing: false,
		}),
	])
	return { ...detail, hasCommunityListing }
}

export async function loadAccountPackagesData(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	pathPackageId?: string
}): Promise<AccountPackagesLoaderData> {
	const userId = input.user.mcpUser.userId
	const url = new URL(input.request.url, 'http://localhost')
	const { page, pageSize, offset } = readPagination(url, {
		defaultPageSize,
		maxPageSize,
	})
	const query = url.searchParams.get('q')?.trim() ?? ''
	const appFilter = readAppFilter(url)
	const sort = readSort(url)
	const selectedPackageId = readAccountPackagesSelectedPackageId(
		input.request.url,
		input.pathPackageId,
	)

	const [{ items, total }, selectedRecord] = await Promise.all([
		searchSavedPackagesByUserId(input.env.APP_DB, {
			userId,
			query,
			hasApp: appFilterToHasApp(appFilter),
			sort,
			limit: pageSize,
			offset,
		}),
		selectedPackageId
			? getSavedPackageWithCommunityProvenanceById(input.env.APP_DB, {
					userId,
					packageId: selectedPackageId,
				})
			: Promise.resolve(null),
	])
	const [provenanceRecords, selectedPackage] = await Promise.all([
		listSavedPackageCommunityProvenanceByIds(input.env.APP_DB, {
			userId,
			packageIds: items.map((item) => item.id),
		}).then((records) =>
			applySavedPackageForkListingAncestry({ env: input.env, records }),
		),
		selectedRecord
			? applySavedPackageForkListingAncestry({
					env: input.env,
					records: [selectedRecord],
				}).then(([enrichedSelected]) =>
					enrichedSelected
						? toDetailWithListingState({
								env: input.env,
								requestUrl: input.request.url,
								userId,
								username: input.user.username,
								record: enrichedSelected,
							})
						: null,
				)
			: null,
	])
	const provenanceById = new Map(
		provenanceRecords.map((record) => [record.id, record]),
	)

	return {
		ok: true,
		email: input.user.email,
		username: input.user.username,
		invocationUrlOrigin: getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		}),
		packages: items.map((item) => {
			const provenance = provenanceById.get(item.id)
			return toListItem(
				item,
				provenance ? toListingAhead(provenance) : null,
				provenance ? toForkAhead(provenance) : null,
			)
		}),
		selectedPackage,
		page,
		pageSize,
		total,
		query,
		appFilter,
		sort,
	}
}
