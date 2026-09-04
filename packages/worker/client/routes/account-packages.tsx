import { type Handle, css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { replaceLocation } from '#client/replace-location.ts'
import {
	createInfiniteList,
	type InfiniteListSnapshot,
} from '#client/infinite-list.ts'
import { infiniteScrollSentinel } from '#client/infinite-scroll.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors } from '#universal/styles/tokens.ts'
import { ForkOutdatedCopyButton } from '#universal/fork-outdated-copy-button.tsx'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import {
	RecordChips,
	RecordDot,
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordCellClamp,
	recordStampCss,
} from './record-table.tsx'
import { packageLockGlyph } from './account-package-owner-details.tsx'
import {
	type AccountPackageListItem,
	type AccountPackagesAppFilter,
	type AccountPackagesLoaderData,
	type AccountPackagesSort,
} from '#universal/loader-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

type PageStatus = 'loading' | 'ready' | 'error'

const accountPackagesApiPath = '/account/packages.json'
const packagesRoute = createListDetailRoute('/account/packages')

type PackageFilterState = {
	search: string
	app: AccountPackagesAppFilter
	sort: AccountPackagesSort
}

function readFilterState(href: string): PackageFilterState {
	const url = new URL(href, 'http://localhost')
	const rawApp = url.searchParams.get('app')?.trim()
	const rawSort = url.searchParams.get('sort')?.trim()
	return {
		search: url.searchParams.get('q')?.trim() ?? '',
		app: rawApp === 'with' || rawApp === 'without' ? rawApp : 'all',
		sort: rawSort === 'created' || rawSort === 'name' ? rawSort : 'updated',
	}
}

function getListKey(href: string) {
	const filters = readFilterState(href)
	return `q=${filters.search}&app=${filters.app}&sort=${filters.sort}`
}

function getDataKey(href: string) {
	return `/account/packages?${getListKey(href)}`
}

function isPackageLocked(lockedAt: string | null | undefined) {
	return typeof lockedAt === 'string' && lockedAt.trim().length > 0
}

function buildOwnerPackageHref(username: string, kodyId: string) {
	return routes.communityPackage.href({ username, kodyId })
}

function buildPackagesApiRequestUrl(
	href: string,
	options?: { page?: number; includeSelected?: boolean },
) {
	const filters = readFilterState(href)
	const requestUrl = new URL(accountPackagesApiPath, 'http://localhost')
	if (filters.search) requestUrl.searchParams.set('q', filters.search)
	if (filters.app !== 'all') requestUrl.searchParams.set('app', filters.app)
	if (filters.sort !== 'updated')
		requestUrl.searchParams.set('sort', filters.sort)
	if (options?.page != null)
		requestUrl.searchParams.set('page', String(options.page))
	const selectedPackageId = packagesRoute.getSelection(href).selectedId
	if (selectedPackageId && options?.includeSelected !== false) {
		requestUrl.searchParams.set('selected', selectedPackageId)
	}
	return `${requestUrl.pathname}${requestUrl.search}`
}

export async function accountPackagesRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const selectedPackageId = packagesRoute.getSelection(href).selectedId
	const response = await fetch(
		buildPackagesApiRequestUrl(href, {
			includeSelected: Boolean(selectedPackageId),
		}),
		{
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		},
	)
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountPackagesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load your packages.')
	}
	if (selectedPackageId && payload.selectedPackage) {
		const destination = new URL(
			buildOwnerPackageHref(payload.username, payload.selectedPackage.kodyId),
			url,
		)
		destination.search = url.search
		return routeLoaderRedirect(`${destination.pathname}${destination.search}`)
	}
	if (selectedPackageId && !payload.selectedPackage) {
		throw new Error('Package not found.')
	}
	return { accountPackages: payload }
}

export function AccountPackagesRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let loadedThroughPage = 1
	const packageList = createInfiniteList<AccountPackageListItem>({
		mergeDirection: 'append',
		getKey: (pkg) => pkg.id,
		onSnapshot: (snapshot) => {
			packagesSnapshot = snapshot
		},
	})
	let packagesSnapshot: InfiniteListSnapshot<AccountPackageListItem> =
		packageList.getSnapshot()
	let username = ''
	let message: string | null = null
	let loadRequestId = 0
	let lastLoadedDataKey = ''
	let lastLoadedListKey = ''
	let loadingDataKey: string | null = null
	let lastFailedDataKey: string | null = null

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function buildHrefWithUpdatedFilters(
		nextFilters: Partial<PackageFilterState>,
	) {
		const url = new URL(getCurrentHref(), 'http://localhost')
		const filters = { ...readFilterState(url.toString()), ...nextFilters }
		if (filters.search) url.searchParams.set('q', filters.search)
		else url.searchParams.delete('q')
		if (filters.app !== 'all') url.searchParams.set('app', filters.app)
		else url.searchParams.delete('app')
		if (filters.sort !== 'updated') url.searchParams.set('sort', filters.sort)
		else url.searchParams.delete('sort')
		url.searchParams.delete('page')
		return `${url.pathname}${url.search}`
	}

	function applyPayload(payload: AccountPackagesLoaderData, href: string) {
		const listKey = getListKey(href)
		if (listKey !== lastLoadedListKey || loadedThroughPage <= 1) {
			loadedThroughPage = payload.page
			packageList.reset()
			packageList.replaceWindow({
				items: payload.packages,
				hasMore: payload.page * payload.pageSize < payload.total,
				totalCount: payload.total,
			})
			lastLoadedListKey = listKey
		}
		username = payload.username
		message = null
		status = 'ready'
		lastLoadedDataKey = getDataKey(href)
		lastFailedDataKey = null
	}

	async function loadAccountPackages() {
		const href = getCurrentHref()
		const dataKey = getDataKey(href)
		loadingDataKey = dataKey
		const requestId = ++loadRequestId
		try {
			const response = await fetch(
				buildPackagesApiRequestUrl(href, { includeSelected: false }),
				{
					headers: { Accept: 'application/json' },
					credentials: 'include',
				},
			)
			if (
				requestId !== loadRequestId ||
				getDataKey(getCurrentHref()) !== dataKey
			)
				return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountPackagesLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load your packages.')
			}
			applyPayload(payload, href)
			handle.update()
		} catch (error) {
			if (
				requestId !== loadRequestId ||
				getDataKey(getCurrentHref()) !== dataKey
			)
				return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load your packages.'
			lastFailedDataKey = dataKey
			handle.update()
		} finally {
			if (requestId === loadRequestId && loadingDataKey === dataKey) {
				loadingDataKey = null
			}
		}
	}

	async function loadMorePackages() {
		if (status !== 'ready') return false
		const nextPage = loadedThroughPage + 1
		const loaded = await packageList.loadMore(async () => {
			const requestUrl = buildPackagesApiRequestUrl(getCurrentHref(), {
				page: nextPage,
				includeSelected: false,
			})
			const response = await fetch(requestUrl, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (response.status === 401) {
				window.location.assign('/login')
				throw new Error('Signed out.')
			}
			const payload = await readJson<AccountPackagesLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load more packages.')
			}
			return {
				items: payload.packages,
				hasMore: payload.page * payload.pageSize < payload.total,
				totalCount: payload.total,
			}
		})
		if (loaded) {
			loadedThroughPage = nextPage
		}
		handle.update()
		return loaded
	}

	function applyRouteLoaderData(href: string) {
		if (!packagesRoute.isRoutePath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'accountPackages', href)
		if (!routeData) return false
		applyPayload(routeData, href)
		return true
	}

	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	let lastSeenDataKey = ''

	return () => {
		const currentHref = getCurrentHref()
		const currentDataKey = getDataKey(currentHref)
		if (currentDataKey !== lastSeenDataKey) {
			lastSeenDataKey = currentDataKey
			lastFailedDataKey = null
		}
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad =
			(status === 'loading' ||
				currentDataKey !== lastLoadedDataKey ||
				needsStaleRefresh) &&
			currentDataKey !== lastFailedDataKey &&
			loadingDataKey !== currentDataKey
		if (!appliedRouteData && needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			loadingDataKey = currentDataKey
			handle.queueTask(loadAccountPackages)
		}

		const {
			items: packages,
			hasMore,
			totalCount,
			isLoadingMore,
		} = packagesSnapshot
		const filters = readFilterState(currentHref)
		const hasActiveFilters = Boolean(filters.search || filters.app !== 'all')

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Packages"
					description="Browse your saved packages. Open a row to manage visibility, publish lock, and deletion on the package page."
					currentHref={currentHref}
				/>
				{status === 'loading' && lastLoadedDataKey === '' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading packages…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={status === 'error' ? 'error' : 'info'}
					>
						{message}
					</AccountManagementMessage>
				) : null}
				<RecordTable
					mode="none"
					busy={status === 'loading'}
					ariaLabel="Saved packages"
					countLabel={`${packages.length} of ${totalCount} ${totalCount === 1 ? 'package' : 'packages'}`}
					emptyLabel={
						status === 'ready'
							? hasActiveFilters
								? 'No packages match the current filters.'
								: 'No saved packages yet. Ask Kody to save one to get started.'
							: 'Loading packages…'
					}
					toolbar={
						<>
							<RecordTableSearch
								label="Search packages"
								placeholder="Search by name, id, description, or tag"
								value={filters.search}
								onInput={(value) => {
									replaceLocation(
										buildHrefWithUpdatedFilters({ search: value }),
									)
								}}
							/>
							<RecordTableSelect
								label="Filter packages by app"
								value={filters.app}
								onChange={(value) => {
									replaceLocation(
										buildHrefWithUpdatedFilters({
											app: value as AccountPackagesAppFilter,
										}),
									)
								}}
							>
								<option value="all">All packages</option>
								<option value="with">With an app</option>
								<option value="without">Without an app</option>
							</RecordTableSelect>
							<RecordTableSelect
								label="Sort packages"
								value={filters.sort}
								onChange={(value) => {
									replaceLocation(
										buildHrefWithUpdatedFilters({
											sort: value as AccountPackagesSort,
										}),
									)
								}}
							>
								<option value="updated">Recently updated</option>
								<option value="created">Recently created</option>
								<option value="name">Name</option>
							</RecordTableSelect>
						</>
					}
					columns={[
						{ key: 'name', label: 'Name', primary: true },
						{ key: 'kodyId', label: 'Kody id', drop: 2 },
						{ key: 'hasApp', label: 'App' },
						{ key: 'tags', label: 'Tags', drop: 1 },
						{ key: 'updated', label: 'Updated', drop: 3 },
					]}
					rows={packages.map((pkg) => ({
						id: pkg.id,
						href: username
							? buildOwnerPackageHref(username, pkg.kodyId)
							: undefined,
						...(pkg.listingAhead || isPackageLocked(pkg.lockedAt)
							? {
									primaryAccessory: (
										<span
											mix={css({
												display: 'inline-flex',
												alignItems: 'center',
												gap: '0.35rem',
											})}
										>
											{isPackageLocked(pkg.lockedAt) ? (
												<span
													title="Publish lock on"
													data-testid={`account-package-locked-${pkg.id}`}
													mix={css({
														display: 'inline-flex',
														color: colors.textMuted,
														flexShrink: 0,
													})}
												>
													{packageLockGlyph(true)}
												</span>
											) : null}
											{pkg.listingAhead ? (
												<ForkOutdatedCopyButton
													prompt={pkg.listingAhead.prompt}
													testId={`account-package-listing-ahead-${pkg.id}`}
												/>
											) : null}
										</span>
									),
								}
							: {}),
						cells: {
							name: <span mix={css(recordCellClamp(36))}>{pkg.name}</span>,
							kodyId: (
								<code
									mix={css({
										fontSize: '0.8rem',
										color: colors.textMuted,
										...recordCellClamp(28),
									})}
								>
									{pkg.kodyId}
								</code>
							),
							hasApp: (
								<RecordDot
									active={pkg.hasApp}
									title={pkg.hasApp ? 'Declares a package app' : 'No app'}
								/>
							),
							tags: <RecordChips items={pkg.tags.slice(0, 3)} />,
							updated: (
								<span mix={css(recordStampCss)}>
									{formatTimestampDate(pkg.updatedAt)}
								</span>
							),
						},
					}))}
					footer={
						hasMore ? (
							<div mix={infiniteScrollSentinel(loadMorePackages)}>
								<button
									type="button"
									disabled={isLoadingMore}
									mix={[
										on('click', () => void loadMorePackages()),
										css({ ...secondaryButtonCss, width: '100%' }),
									]}
								>
									{isLoadingMore ? 'Loading more…' : 'Load more'}
								</button>
							</div>
						) : null
					}
				/>
			</AccountManagementShell>
		)
	}
}
