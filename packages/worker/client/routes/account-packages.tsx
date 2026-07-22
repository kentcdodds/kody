import { formatTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
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
import {
	cardCss,
	fieldCss,
	fieldLabelCss,
	getSecondaryButtonCss,
	inputCss,
} from '#client/styles/style-primitives.ts'
import {
	AccountManagementLayout,
	AccountManagementList,
	AccountManagementListItemButton,
	AccountManagementMessage,
	AccountManagementSearchField,
	AccountManagementShell,
	AccountPageHeader,
	AccountManagementSidebar,
	MetadataGrid,
} from './account-management-components.tsx'
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

const packagesBasePath = '/account/packages'
const accountPackagesApiPath = '/account/packages.json'

type PackageFilterState = {
	search: string
	app: AccountPackagesAppFilter
	sort: AccountPackagesSort
}

function isAccountPackagesPath(href: string) {
	const path = new URL(href, 'http://localhost').pathname
	return path === packagesBasePath || path.startsWith(`${packagesBasePath}/`)
}

function getSelectedPackageId(href: string) {
	const pathname = new URL(href, 'http://localhost').pathname
	const detailPrefix = `${packagesBasePath}/`
	if (!pathname.startsWith(detailPrefix)) return null
	const packageId = decodeURIComponent(pathname.slice(detailPrefix.length))
	return packageId || null
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
	const selectedPackageId = getSelectedPackageId(href)
	if (selectedPackageId && options?.includeSelected !== false) {
		requestUrl.searchParams.set('selected', selectedPackageId)
	}
	return `${requestUrl.pathname}${requestUrl.search}`
}

function buildPackageHref(packageId: string, search: string) {
	return `${packagesBasePath}/${encodeURIComponent(packageId)}${search}`
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

function formatUpdatedDate(updatedAt: string) {
	return `Updated ${new Date(updatedAt).toLocaleDateString()}`
}

const truncatedTextCss = {
	minWidth: 0,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
} as const

const tagChipCss = {
	display: 'inline-block',
	padding: `0 ${spacing.sm}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
	lineHeight: '1.5rem',
} as const

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
			getSelectedPackageId(href) && !payload.selectedPackage
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
		if (!isAccountPackagesPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'accountPackages', href)
		if (!routeData) return false
		applyPayload(routeData, href)
		return true
	}

	const secondaryButtonCss = getSecondaryButtonCss()
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
		const selectedPackageId = getSelectedPackageId(currentHref)
		const activePackageId = selectedPackageId ?? selectedPackage?.id ?? null

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Packages"
					description="Browse your saved packages and review their metadata. Packages are created and edited through Kody's MCP tools."
					currentHref={currentHref}
				/>
				{status === 'loading' ? (
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
				<AccountManagementLayout
					sidebar={
						<AccountManagementSidebar
							title="Saved packages"
							description="Select a package to review its metadata."
						>
							<div mix={css({ display: 'grid', gap: spacing.sm })}>
								<AccountManagementSearchField
									label="Search"
									placeholder="Search by name, id, description, or tag"
									value={filters.search}
									onInput={(value) => {
										replaceLocation(
											buildHrefWithUpdatedFilters({ search: value }),
										)
									}}
								/>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>App</span>
									<select
										value={filters.app}
										aria-label="Filter packages by app"
										mix={[
											on('change', (event) => {
												const nextApp = event.currentTarget
													.value as AccountPackagesAppFilter
												replaceLocation(
													buildHrefWithUpdatedFilters({ app: nextApp }),
												)
											}),
											css(inputCss),
										]}
									>
										<option value="all">All packages</option>
										<option value="with">With an app</option>
										<option value="without">Without an app</option>
									</select>
								</label>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Sort</span>
									<select
										value={filters.sort}
										aria-label="Sort packages"
										mix={[
											on('change', (event) => {
												const nextSort = event.currentTarget
													.value as AccountPackagesSort
												replaceLocation(
													buildHrefWithUpdatedFilters({ sort: nextSort }),
												)
											}),
											css(inputCss),
										]}
									>
										<option value="updated">Recently updated</option>
										<option value="created">Recently created</option>
										<option value="name">Name</option>
									</select>
								</label>
							</div>
							{status === 'ready' && packages.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									{hasActiveFilters
										? 'No packages match the current filters.'
										: 'No saved packages yet. Ask Kody to save one to get started.'}
								</p>
							) : (
								<>
									<AccountManagementList maxHeight="min(65vh, 48rem)">
										{packages.map((pkg) => (
											<li key={pkg.id} mix={css({ minWidth: 0 })}>
												<AccountManagementListItemButton
													active={activePackageId === pkg.id}
													onClick={() => {
														navigate(
															buildPackageHref(pkg.id, getCurrentSearch()),
														)
													}}
												>
													<div
														mix={css({
															display: 'grid',
															gridTemplateColumns: 'minmax(0, 1fr) auto',
															gap: spacing.md,
															alignItems: 'baseline',
															minWidth: 0,
														})}
													>
														<strong
															mix={css({
																...truncatedTextCss,
																display: 'block',
															})}
														>
															{pkg.name}
														</strong>
														<span
															mix={css({
																fontSize: typography.fontSize.xs,
																color: colors.textMuted,
															})}
														>
															{formatUpdatedDate(pkg.updatedAt)}
														</span>
													</div>
													<span
														mix={css({
															...truncatedTextCss,
															display: 'block',
															fontSize: typography.fontSize.sm,
															color: colors.textMuted,
														})}
													>
														{pkg.kodyId}
														{pkg.hasApp ? ' - has app' : ''}
													</span>
													{pkg.description ? (
														<span
															mix={css({
																display: '-webkit-box',
																fontSize: typography.fontSize.sm,
																color: colors.textMuted,
																overflow: 'hidden',
																overflowWrap: 'anywhere',
																textOverflow: 'ellipsis',
																'-webkit-box-orient': 'vertical',
																'-webkit-line-clamp': '2',
															})}
														>
															{pkg.description}
														</span>
													) : null}
												</AccountManagementListItemButton>
											</li>
										))}
										{hasMore ? (
											<li
												key="load-more-sentinel"
												mix={[
													infiniteScrollSentinel(loadMorePackages),
													css({ display: 'grid' }),
												]}
											>
												<button
													type="button"
													disabled={isLoadingMore}
													mix={[
														on('click', () => void loadMorePackages()),
														css(secondaryButtonCss),
													]}
												>
													{isLoadingMore ? 'Loading more…' : 'Load more'}
												</button>
											</li>
										) : null}
									</AccountManagementList>
									{packagesSnapshot.error ? (
										<AccountManagementMessage tone="error">
											{packagesSnapshot.error}
										</AccountManagementMessage>
									) : null}
									{status === 'ready' ? (
										<p
											mix={css({
												margin: 0,
												marginTop: spacing.sm,
												color: colors.textMuted,
												fontSize: typography.fontSize.xs,
											})}
										>
											Showing {packages.length} of {totalCount}{' '}
											{totalCount === 1 ? 'package' : 'packages'}
										</p>
									) : null}
								</>
							)}
						</AccountManagementSidebar>
					}
				>
					<div mix={css({ ...cardCss, gap: spacing.lg })}>
						{selectedPackage ? (
							<>
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
									<div
										mix={css({
											display: 'flex',
											gap: spacing.xs,
											flexWrap: 'wrap',
										})}
									>
										{selectedPackage.tags.map((tag) => (
											<span key={tag} mix={css(tagChipCss)}>
												{tag}
											</span>
										))}
									</div>
								) : null}
								<MetadataGrid
									columns={3}
									items={[
										{ label: 'Kody id', value: selectedPackage.kodyId },
										{
											label: 'Package id',
											value: (
												<code mix={css({ overflowWrap: 'anywhere' })}>
													{selectedPackage.id}
												</code>
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
												<code mix={css({ overflowWrap: 'anywhere' })}>
													{selectedPackage.sourceId}
												</code>
											),
										},
										{
											label: 'Created',
											value: formatTimestamp(selectedPackage.createdAt),
										},
										{
											label: 'Updated',
											value: formatTimestamp(selectedPackage.updatedAt),
										},
									]}
								/>
								{selectedPackage.searchText ? (
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<span mix={css(fieldLabelCss)}>Search text</span>
										<p
											mix={css({
												margin: 0,
												color: colors.textMuted,
												overflowWrap: 'anywhere',
											})}
										>
											{selectedPackage.searchText}
										</p>
									</div>
								) : null}
							</>
						) : (
							<div mix={css({ display: 'grid', gap: spacing.sm })}>
								<h2
									mix={css({
										margin: 0,
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
										color: colors.text,
									})}
								>
									Select a package
								</h2>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Pick a package from the list to review its metadata.
								</p>
							</div>
						)}
					</div>
				</AccountManagementLayout>
			</AccountManagementShell>
		)
	}
}
