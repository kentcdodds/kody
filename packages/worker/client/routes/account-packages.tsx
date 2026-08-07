import { type Handle, css } from 'remix/ui'
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
import { colors, radius, spacing, typography } from '#client/styles/tokens.ts'
import { getGhostButtonCss } from '#client/styles/style-primitives.ts'
import {
	accountDisclosureCss,
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import {
	RecordChips,
	RecordDot,
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordBodyCss,
	recordStampCss,
} from './record-table.tsx'
import {
	type AccountPackageDetail,
	type AccountPackageListItem,
	type AccountPackagesAppFilter,
	type AccountPackagesLoaderData,
	type AccountPackagesSort,
} from '#app/loader-data.ts'
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

/**
 * The list window only depends on the filters, not on which package is
 * selected — selection-only navigations keep the loaded scroll window.
 */
function getListKey(href: string) {
	const filters = readFilterState(href)
	return `q=${filters.search}&app=${filters.app}&sort=${filters.sort}`
}

function getDataKey(href: string) {
	const pathname = new URL(href, 'http://localhost').pathname
	return `${pathname}?${getListKey(href)}`
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
	const response = await fetch(buildPackagesApiRequestUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountPackagesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load your packages.')
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
	let selectedPackage: AccountPackageDetail | null = null
	let message: string | null = null
	let loadRequestId = 0
	let lastLoadedDataKey = ''
	let lastLoadedListKey = ''
	let loadingDataKey: string | null = null
	let lastFailedDataKey: string | null = null

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
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
		// Selection-only navigations deep in the scroll window keep the
		// already-loaded pages; anything else reseeds from page one so
		// filter changes and plain revisits always show fresh data.
		if (listKey !== lastLoadedListKey || loadedThroughPage <= 1) {
			loadedThroughPage = payload.page
			// reset() invalidates any in-flight load-more so a stale page
			// fetched for the previous filters can never append into the
			// fresh window.
			packageList.reset()
			packageList.replaceWindow({
				items: payload.packages,
				hasMore: payload.page * payload.pageSize < payload.total,
				totalCount: payload.total,
			})
			lastLoadedListKey = listKey
		}
		selectedPackage = payload.selectedPackage
		message =
			packagesRoute.getSelection(href).selectedId && !payload.selectedPackage
				? 'Package not found.'
				: null
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
			const response = await fetch(buildPackagesApiRequestUrl(href), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
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
		// The failure latch only guards retry loops for the location that
		// failed; leaving it (or coming back) must allow a fresh attempt.
		if (currentDataKey !== lastSeenDataKey) {
			lastSeenDataKey = currentDataKey
			lastFailedDataKey = null
		}
		// Consume route-loader data before deriving the list snapshot below;
		// deriving first would render this pass from stale pre-navigation
		// closure state.
		const appliedRouteData = applyRouteLoaderData(currentHref)
		// A same-path refresh whose loader failed leaves no preload and no
		// data-key change; the stale marker forces the fallback refetch.
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
		const selectedPackageId = packagesRoute.getSelection(currentHref).selectedId
		const activePackageId = selectedPackageId ?? selectedPackage?.id ?? null

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Packages"
					description="Browse your saved packages and review their metadata. Packages are created and edited through Kody's MCP tools."
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
					mode="expand"
					busy={status === 'loading'}
					ariaLabel="Saved packages"
					selectedId={activePackageId}
					// Unconditional: the snapshot keeps the previous window during a
					// refetch, and dropping the slot mid-refetch resized the search
					// field the reader is typing into.
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
						{ key: 'updated', label: 'Updated' },
					]}
					rows={packages.map((pkg) => ({
						id: pkg.id,
						href: packagesRoute.buildDetailHref(pkg.id, getCurrentSearch()),
						cells: {
							name: pkg.name,
							kodyId: (
								<code
									mix={css({
										fontSize: '0.8rem',
										color: colors.textMuted,
										whiteSpace: 'nowrap',
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
					record={
						selectedPackage ? (
							<div mix={css(recordBodyCss)}>
								<div mix={css({ display: 'grid', gap: spacing.xs })}>
									<h2
										mix={css({
											margin: 0,
											fontSize: typography.fontSize.lg,
											fontWeight: typography.fontWeight.semibold,
											color: colors.text,
											overflowWrap: 'anywhere',
										})}
									>
										{selectedPackage.name}
									</h2>
									{selectedPackage.description ? (
										<p
											mix={css({
												margin: 0,
												color: colors.textMuted,
												overflowWrap: 'anywhere',
											})}
										>
											{selectedPackage.description}
										</p>
									) : (
										<p mix={css({ margin: 0, color: colors.textMuted })}>
											This package has no description.
										</p>
									)}
								</div>
								{selectedPackage.tags.length > 0 ? (
									<RecordChips items={selectedPackage.tags} />
								) : null}
								<MetadataGrid
									items={[
										{
											label: 'Kody id',
											value: (
												<IdValue
													value={selectedPackage.kodyId}
													label="Kody id"
												/>
											),
										},
										{
											label: 'Package id',
											value: (
												<IdValue
													value={selectedPackage.id}
													label="package id"
												/>
											),
										},
										{
											label: 'App',
											value: selectedPackage.hasApp
												? 'Declares a package app'
												: 'No app',
										},
										{
											label: 'Source id',
											value: (
												<IdValue
													value={selectedPackage.sourceId}
													label="source id"
												/>
											),
										},
										{
											label: 'Created',
											value: (
												<TimestampValue value={selectedPackage.createdAt} />
											),
										},
										{
											label: 'Updated',
											value: (
												<TimestampValue value={selectedPackage.updatedAt} />
											),
										},
									]}
								/>
								{selectedPackage.searchText ? (
									// The search index is a wall of concatenated text with no
									// reading order. Left in flow it set the height of the whole
									// screen; behind a disclosure it costs a line until asked
									// for, and the box scrolls rather than growing.
									<details mix={css(accountDisclosureCss)}>
										<summary>Search text</summary>
										<p
											mix={css({
												margin: 0,
												maxHeight: '12rem',
												overflowY: 'auto',
												padding: spacing.sm,
												borderRadius: radius.md,
												border: `1px solid ${colors.border}`,
												backgroundColor: colors.background,
												color: colors.textMuted,
												fontSize: typography.fontSize.sm,
												overflowWrap: 'anywhere',
											})}
										>
											{selectedPackage.searchText}
										</p>
									</details>
								) : null}
							</div>
						) : null
					}
				/>
			</AccountManagementShell>
		)
	}
}
