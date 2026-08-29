import { buildListingAheadPrompt } from '#universal/community-listing-ahead.ts'
import { getCommunityListingHref } from '#universal/community-links.ts'
import {
	type AccountPackageDetail,
	type AccountPackageListItem,
	type AccountPackageListingAhead,
	type AccountPackageToken,
	type AccountPackagesAppFilter,
	type AccountPackagesLoaderData,
	type AccountPackagesSort,
} from '#universal/loader-data.ts'
import { listPackageManifestExportNames } from '#universal/package-token-export-selection.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	listPackageInvocationTokensByPackageId,
	type PackageInvocationTokenRecord,
} from '#worker/package-invocations/repo.ts'
import { readPagination } from '#worker/query-params.ts'
import { getCommunityListingByOwnerAndPackage } from '#worker/community/repo.ts'
import {
	getSavedPackageWithCommunityProvenanceById,
	getSavedPackageWithCommunityProvenanceByKodyId,
	listSavedPackageCommunityProvenanceByIds,
	searchSavedPackagesByUserId,
} from '#worker/package-registry/repo.ts'
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
	}
}

function toListItem(
	record: SavedPackageRecord,
	listingAhead: AccountPackageListingAhead | null = null,
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
	}
}

function toToken(token: PackageInvocationTokenRecord): AccountPackageToken {
	return {
		id: token.id,
		name: token.name,
		exportNames: token.exportNames,
		createdAt: token.created_at,
		updatedAt: token.updated_at,
		lastUsedAt: token.last_used_at,
		revokedAt: token.revoked_at,
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
	record: SavedPackageWithCommunityProvenanceRecord
	hasCommunityListing: boolean
}): Promise<AccountPackageDetail> {
	const [tokens, exports, source] = await Promise.all([
		listPackageInvocationTokensByPackageId({
			db: input.env.APP_DB,
			userId: input.userId,
			packageId: input.record.id,
		}),
		loadPackageExportNames({
			env: input.env,
			requestUrl: input.requestUrl,
			userId: input.userId,
			sourceId: input.record.sourceId,
		}),
		getEntitySourceById(input.env.APP_DB, input.record.sourceId),
	])
	return {
		...toListItem(input.record, toListingAhead(input.record)),
		hasCommunityListing: input.hasCommunityListing,
		searchText: input.record.searchText,
		exports,
		tokens: tokens.map(toToken),
		publishedCommit:
			source?.user_id === input.userId
				? (source.published_commit ?? null)
				: null,
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
	packageId?: string
	kodyId?: string
}): Promise<AccountPackageDetail | null> {
	const record = input.kodyId
		? await getSavedPackageWithCommunityProvenanceByKodyId(input.env.APP_DB, {
				userId: input.userId,
				kodyId: input.kodyId,
			})
		: input.packageId
			? await getSavedPackageWithCommunityProvenanceById(input.env.APP_DB, {
					userId: input.userId,
					packageId: input.packageId,
				})
			: null
	if (!record) return null
	return toDetail({
		env: input.env,
		requestUrl: input.requestUrl,
		userId: input.userId,
		record,
		hasCommunityListing: await hasActiveCommunityListing({
			db: input.env.APP_DB,
			userId: input.userId,
			packageId: record.id,
		}),
	})
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
	const provenanceById = new Map(
		(
			await listSavedPackageCommunityProvenanceByIds(input.env.APP_DB, {
				userId,
				packageIds: items.map((item) => item.id),
			})
		).map((record) => [record.id, record]),
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
			return toListItem(item, provenance ? toListingAhead(provenance) : null)
		}),
		selectedPackage: selectedRecord
			? await toDetail({
					env: input.env,
					requestUrl: input.request.url,
					userId,
					record: selectedRecord,
					hasCommunityListing: await hasActiveCommunityListing({
						db: input.env.APP_DB,
						userId,
						packageId: selectedRecord.id,
					}),
				})
			: null,
		page,
		pageSize,
		total,
		query,
		appFilter,
		sort,
	}
}
