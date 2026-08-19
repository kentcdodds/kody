import {
	type AccountPackageDetail,
	type AccountPackageListItem,
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
import {
	getSavedPackageById,
	searchSavedPackagesByUserId,
} from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'

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

function toListItem(record: SavedPackageRecord): AccountPackageListItem {
	return {
		id: record.id,
		name: record.name,
		kodyId: record.kodyId,
		description: record.description,
		tags: record.tags,
		hasApp: record.hasApp,
		sourceId: record.sourceId,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
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
	record: SavedPackageRecord
}): Promise<AccountPackageDetail> {
	const [tokens, exports] = await Promise.all([
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
	])
	return {
		...toListItem(input.record),
		searchText: input.record.searchText,
		exports,
		tokens: tokens.map(toToken),
	}
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
			? getSavedPackageById(input.env.APP_DB, {
					userId,
					packageId: selectedPackageId,
				})
			: Promise.resolve(null),
	])

	return {
		ok: true,
		email: input.user.email,
		username: input.user.username,
		invocationUrlOrigin: getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		}),
		packages: items.map(toListItem),
		selectedPackage: selectedRecord
			? await toDetail({
					env: input.env,
					requestUrl: input.request.url,
					userId,
					record: selectedRecord,
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
