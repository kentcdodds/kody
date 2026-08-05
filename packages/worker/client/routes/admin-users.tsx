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
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, mq, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
	getPillButtonCss,
	getSelectCss,
} from '#client/styles/style-primitives.ts'
import {
	AccountManagementLayout,
	AccountManagementList,
	AccountManagementListItemButton,
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementSearchField,
	AccountManagementShell,
	AccountManagementSidebar,
	AdminPageHeader,
	MetadataGrid,
	accountManagementTableCellCss,
	accountManagementTableCss,
	accountManagementTableNumericCellCss,
	noticeCardCss,
} from './account-management-components.tsx'
import { ChartLegend } from '#client/charts/chart-legend.tsx'
import { StackedBarChart } from '#client/charts/stacked-bar-chart.tsx'
import { chartColor, formatIntegerNumber } from '#client/charts/chart-theme.ts'
import {
	formatMonthKeyLabel,
	usageMetricSeries,
} from '#client/charts/usage-metric-series.ts'
import { type RoleName } from '#worker/identity/permissions.ts'
import {
	type AdminPlanName,
	type AdminUserListItem,
	type AdminUsersLoaderData,
	type AdminUsersMutationData,
	type AdminUserUsageLoaderData,
} from '#app/loader-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

const selectCss = getSelectCss()

type AccountStatus = 'loading' | 'ready' | 'error'
type UsageStatus = 'loading' | 'ready' | 'error'

const adminUsersApiPath = '/admin/users.json'
const adminUserUsageApiPath = '/admin/users/usage.json'
const {
	isRoutePath: isAdminUsersListDetailPath,
	getSelection,
	buildDetailHref,
} = createListDetailRoute('/admin/users')

function formatUsageLimit(limit: number) {
	return formatIntegerNumber(limit)
}

function formatUsagePercent(value: number | null) {
	if (value === null) return '—'
	return `${Math.round(value * 100)}%`
}

function isAdminUsersPath(href: string) {
	const path = new URL(href, 'http://localhost').pathname
	return path === '/admin' || isAdminUsersListDetailPath(href)
}

type AdminUserFilterState = {
	search: string
	role: string
}

/** Read the `q`/`role` filter params the server applies to the list. */
function readFilterState(href: string): AdminUserFilterState {
	const url = new URL(href, 'http://localhost')
	return {
		search: url.searchParams.get('q')?.trim() ?? '',
		role: url.searchParams.get('role')?.trim() ?? '',
	}
}

/**
 * The list window only depends on the filters, not on which user is
 * selected — selection-only navigations keep the loaded scroll window.
 */
function getListKey(href: string) {
	const filters = readFilterState(href)
	return `q=${filters.search}&role=${filters.role}`
}

function getDataKey(href: string) {
	const pathname = new URL(href, 'http://localhost').pathname
	return `${pathname}?${getListKey(href)}`
}

function parseSelectedStableUserId(value: string | null): string | null {
	if (!value || !/^[a-f0-9]{64}$/.test(value)) return null
	return value
}

/**
 * Translate a detail pathname into the JSON API's `?selected=` param and
 * drop a stale `?page=` so initial loads always re-anchor at page one.
 */
function buildAdminUsersApiRequestUrl(
	href: string,
	options?: { page?: number; includeSelected?: boolean },
) {
	const pageUrl = new URL(href, 'http://localhost')
	const requestUrl = new URL(adminUsersApiPath, 'http://localhost')
	requestUrl.search = pageUrl.search
	requestUrl.searchParams.delete('page')
	if (options?.page != null) {
		requestUrl.searchParams.set('page', String(options.page))
	}
	const selectedId = getSelection(href).selectedId
	if (selectedId && options?.includeSelected !== false) {
		requestUrl.searchParams.set('selected', selectedId)
	} else {
		requestUrl.searchParams.delete('selected')
	}
	return `${requestUrl.pathname}${requestUrl.search}`
}

export async function adminUsersRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildAdminUsersApiRequestUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view admin users.')
	}
	const payload = await readJson<AdminUsersLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load admin users.')
	}
	return { adminUsers: payload }
}

export function AdminUsersRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let availableRoles: Array<RoleName> = []
	let availablePlans: Array<AdminPlanName> = []
	let loadedThroughPage = 1
	const userList = createInfiniteList<AdminUserListItem>({
		mergeDirection: 'append',
		getKey: (user) => user.stableUserId,
		onSnapshot: (snapshot) => {
			usersSnapshot = snapshot
		},
	})
	let usersSnapshot: InfiniteListSnapshot<AdminUserListItem> =
		userList.getSnapshot()
	// Fallback when the URL-selected user is outside the loaded list window
	// (deep link / filtered out). Prefer the in-list row when present.
	let selectedUserFallback: AdminUserListItem | null = null
	let message: string | null = null
	let actionState:
		| 'idle'
		| 'assigning'
		| 'removing'
		| 'saving-plan'
		| 'moderating' = 'idle'
	let selectedRoleToAssign = 'user' as RoleName
	// Draft follows the selected user (see the render body) until the admin
	// edits it. Null stored plan values are shown/saved as `free`.
	let selectedPlanChoice: AdminPlanName = 'free'
	let planDraftStableUserId: string | null = null
	let loadRequestId = 0
	let lastLoadedDataKey = ''
	let lastLoadedListKey = ''
	let loadingDataKey: string | null = null
	let lastFailedDataKey: string | null = null
	let usageStatus: UsageStatus = 'loading'
	let usageData: AdminUserUsageLoaderData | null = null
	let usageMessage: string | null = null
	let usageRequestId = 0
	let usageLoadedForStableUserId: string | null = null
	let usageLoadingForStableUserId: string | null = null
	let usageFailedForStableUserId: string | null = null

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function getSelectedStableUserIdFromHref(href: string) {
		return parseSelectedStableUserId(getSelection(href).selectedId)
	}

	function resolveSelectedUser(href: string) {
		const selectedStableUserId = getSelectedStableUserIdFromHref(href)
		if (selectedStableUserId == null) return null
		return (
			usersSnapshot.items.find(
				(user) => user.stableUserId === selectedStableUserId,
			) ??
			(selectedUserFallback?.stableUserId === selectedStableUserId
				? selectedUserFallback
				: null)
		)
	}

	function applyPayload(payload: AdminUsersLoaderData, href: string) {
		availableRoles = payload.availableRoles
		availablePlans = payload.availablePlans
		const listKey = getListKey(href)
		// Selection-only navigations deep in the scroll window keep the
		// already-loaded pages; anything else reseeds from page one so
		// filter changes and plain revisits always show fresh data.
		if (listKey !== lastLoadedListKey || loadedThroughPage <= 1) {
			loadedThroughPage = payload.page
			// reset() invalidates any in-flight load-more so a stale page
			// fetched for the previous filters can never append into the
			// fresh window.
			userList.reset()
			userList.replaceWindow({
				items: payload.users,
				hasMore: payload.page * payload.pageSize < payload.total,
				totalCount: payload.total,
			})
			lastLoadedListKey = listKey
		}
		selectedUserFallback = payload.selectedUser
		resetPlanDraft()
		message =
			getSelectedStableUserIdFromHref(href) != null && !payload.selectedUser
				? 'User not found.'
				: null
		status = 'ready'
		lastLoadedDataKey = getDataKey(href)
		lastFailedDataKey = null
	}

	function buildHrefWithUpdatedFilters(
		nextFilters: Partial<AdminUserFilterState>,
	) {
		const url = new URL(getCurrentHref(), 'http://localhost')
		const filters = { ...readFilterState(url.toString()), ...nextFilters }
		if (filters.search) url.searchParams.set('q', filters.search)
		else url.searchParams.delete('q')
		if (filters.role) url.searchParams.set('role', filters.role)
		else url.searchParams.delete('role')
		// Filter changes re-anchor the list at the first page.
		url.searchParams.delete('page')
		return `${url.pathname}${url.search}`
	}

	function buildUserDetailHref(stableUserId: string) {
		const url = new URL(getCurrentHref(), 'http://localhost')
		url.searchParams.delete('page')
		return buildDetailHref(stableUserId, url.search)
	}

	async function loadUserUsage(stableUserId: string) {
		usageLoadingForStableUserId = stableUserId
		const requestId = ++usageRequestId
		try {
			const response = await fetch(
				`${adminUserUsageApiPath}?stableUserId=${stableUserId}`,
				{ headers: { Accept: 'application/json' }, credentials: 'include' },
			)
			if (requestId !== usageRequestId) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AdminUserUsageLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load usage for this account.')
			}
			usageData = payload
			usageStatus = 'ready'
			usageMessage = null
			usageLoadedForStableUserId = stableUserId
			usageFailedForStableUserId = null
			handle.update()
		} catch (error) {
			if (requestId !== usageRequestId) return
			usageStatus = 'error'
			usageMessage =
				error instanceof Error
					? error.message
					: 'Unable to load usage for this account.'
			usageFailedForStableUserId = stableUserId
			handle.update()
		} finally {
			if (requestId === usageRequestId) usageLoadingForStableUserId = null
		}
	}

	// Plan changes move entitlement limits, so the drill-down must refetch
	// even though the selected user did not change. Dropping the cached data
	// keeps stale limits from rendering while the refetch is in flight.
	function invalidateUsage() {
		usageData = null
		usageLoadedForStableUserId = null
		usageFailedForStableUserId = null
	}

	// Any refresh of `users` may carry a newer stored plan, so drop the
	// unsaved draft and let the render pass reseed the select from the
	// refreshed record.
	function resetPlanDraft() {
		planDraftStableUserId = null
	}

	async function loadAdminUsers() {
		const href = getCurrentHref()
		const dataKey = getDataKey(href)
		loadingDataKey = dataKey
		const requestId = ++loadRequestId
		try {
			const response = await fetch(buildAdminUsersApiRequestUrl(href), {
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
			if (response.status === 403) {
				status = 'error'
				message = 'You do not have permission to view admin users.'
				lastFailedDataKey = dataKey
				handle.update()
				return
			}
			const payload = await readJson<AdminUsersLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load admin users.')
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
				error instanceof Error ? error.message : 'Unable to load admin users.'
			lastFailedDataKey = dataKey
			handle.update()
		} finally {
			if (requestId === loadRequestId && loadingDataKey === dataKey) {
				loadingDataKey = null
			}
		}
	}

	async function loadMoreUsers() {
		if (status !== 'ready') return false
		const nextPage = loadedThroughPage + 1
		const loaded = await userList.loadMore(async () => {
			const response = await fetch(
				buildAdminUsersApiRequestUrl(getCurrentHref(), {
					page: nextPage,
					includeSelected: false,
				}),
				{
					headers: { Accept: 'application/json' },
					credentials: 'include',
				},
			)
			if (response.status === 401) {
				window.location.assign('/login')
				throw new Error('Signed out.')
			}
			const payload = await readJson<AdminUsersLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load more users.')
			}
			return {
				items: payload.users,
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

	/**
	 * Mutation responses carry the refreshed target user; patch it in place
	 * so a list the admin has scrolled deep into keeps its loaded window and
	 * URL selection instead of resetting to the first page. A role change can
	 * knock the target out of the active role filter, so drop rows that no
	 * longer match and take the refreshed filtered total from the server.
	 */
	function applyMutationPayload(payload: AdminUsersMutationData, href: string) {
		availableRoles = payload.availableRoles
		availablePlans = payload.availablePlans
		const updatedUser = payload.updatedUser
		const { role } = readFilterState(href)
		// The server ignores unknown role values, so only a known role counts
		// as an active filter — otherwise every mutation would wrongly remove
		// its target from the list.
		const activeRoleFilter = (availableRoles as Array<string>).includes(role)
			? role
			: ''
		const matchesRoleFilter =
			!updatedUser ||
			!activeRoleFilter ||
			(updatedUser.roles as Array<string>).includes(activeRoleFilter)
		const currentItems = usersSnapshot.items
		const nextItems = updatedUser
			? matchesRoleFilter
				? currentItems.map((item) =>
						item.stableUserId === updatedUser.stableUserId ? updatedUser : item,
					)
				: currentItems.filter(
						(item) => item.stableUserId !== updatedUser.stableUserId,
					)
			: currentItems
		// reset() invalidates any in-flight load-more so a page fetched before
		// the mutation cannot merge stale rows or counts back in afterward.
		userList.reset()
		userList.replaceWindow({
			items: nextItems,
			hasMore: nextItems.length < payload.total,
			totalCount: payload.total,
		})
		const selectedStableUserId = getSelectedStableUserIdFromHref(href)
		selectedUserFallback =
			payload.selectedUser ??
			(updatedUser &&
			selectedStableUserId != null &&
			updatedUser.stableUserId === selectedStableUserId
				? updatedUser
				: selectedUserFallback)
		resetPlanDraft()
	}

	async function submitRoleAction(action: 'assign_role' | 'remove_role') {
		const href = getCurrentHref()
		const selectedUser = resolveSelectedUser(href)
		if (!selectedUser || actionState !== 'idle') return
		actionState = action === 'assign_role' ? 'assigning' : 'removing'
		message = null
		handle.update()
		try {
			// Carry filters + selected so the mutation response refreshes the
			// same list window and selectedUser fallback the UI is showing.
			const response = await fetch(buildAdminUsersApiRequestUrl(href), {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action,
					stableUserId: selectedUser.stableUserId,
					role: selectedRoleToAssign,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AdminUsersMutationData & { ok?: boolean; error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to update user roles.')
			}
			applyMutationPayload(payload, href)
			lastLoadedDataKey = getDataKey(href)
			message =
				action === 'assign_role'
					? `Assigned ${selectedRoleToAssign} role.`
					: `Removed ${selectedRoleToAssign} role.`
			status = 'ready'
			actionState = 'idle'
			handle.update()
		} catch (error) {
			actionState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to update user roles.'
			handle.update()
		}
	}

	async function submitPlanAction() {
		const href = getCurrentHref()
		const selectedUser = resolveSelectedUser(href)
		if (!selectedUser || actionState !== 'idle') return
		const plan = selectedPlanChoice
		actionState = 'saving-plan'
		message = null
		handle.update()
		try {
			// Carry filters + selected so the mutation response refreshes the
			// same list window and selectedUser fallback the UI is showing.
			const response = await fetch(buildAdminUsersApiRequestUrl(href), {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'update_plan',
					stableUserId: selectedUser.stableUserId,
					plan,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AdminUsersMutationData & { ok?: boolean; error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to update user plan.')
			}
			applyMutationPayload(payload, href)
			invalidateUsage()
			lastLoadedDataKey = getDataKey(href)
			message = `Updated plan to ${plan}.`
			status = 'ready'
			actionState = 'idle'
			handle.update()
		} catch (error) {
			actionState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to update user plan.'
			handle.update()
		}
	}

	async function submitModerationAction(
		action: 'suspend_user' | 'unsuspend_user' | 'resume_email_outbound',
	) {
		const href = getCurrentHref()
		const selectedUser = resolveSelectedUser(href)
		if (!selectedUser || actionState !== 'idle') return
		actionState = 'moderating'
		message = null
		handle.update()
		try {
			// Carry filters + selected so the mutation response refreshes the
			// same list window and selectedUser fallback the UI is showing.
			const response = await fetch(buildAdminUsersApiRequestUrl(href), {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action,
					stableUserId: selectedUser.stableUserId,
				}),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AdminUsersMutationData & { ok?: boolean; error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to update the account.')
			}
			applyMutationPayload(payload, href)
			lastLoadedDataKey = getDataKey(href)
			message =
				action === 'suspend_user'
					? 'Account suspended.'
					: action === 'unsuspend_user'
						? 'Account suspension cleared.'
						: 'Outbound email resumed.'
			status = 'ready'
			actionState = 'idle'
			handle.update()
		} catch (error) {
			actionState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to update the account.'
			handle.update()
		}
	}

	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

	function applyRouteLoaderData(href: string) {
		if (!isAdminUsersPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'adminUsers', href)
		if (!routeData) return false
		applyPayload(routeData, href)
		return true
	}

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
		// Consume route-loader data before deriving the list snapshot and
		// `selectedUser`; deriving first would render this pass from the
		// stale pre-navigation closure state.
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
			handle.queueTask(loadAdminUsers)
		}

		const { items: users, hasMore, totalCount, isLoadingMore } = usersSnapshot
		const filters = readFilterState(currentHref)
		const hasActiveFilters = Boolean(filters.search || filters.role)
		const selectedStableUserId = getSelectedStableUserIdFromHref(currentHref)
		const selectedUser = resolveSelectedUser(currentHref)
		const isMutating = actionState !== 'idle'

		if (
			selectedUser &&
			typeof document !== 'undefined' &&
			usageLoadedForStableUserId !== selectedUser.stableUserId &&
			usageLoadingForStableUserId !== selectedUser.stableUserId &&
			usageFailedForStableUserId !== selectedUser.stableUserId
		) {
			usageStatus = 'loading'
			usageLoadingForStableUserId = selectedUser.stableUserId
			const usageStableUserId = selectedUser.stableUserId
			handle.queueTask(() => loadUserUsage(usageStableUserId))
		}
		// Never render one account's usage under another account's header
		// while the drill-down request is still in flight.
		const selectedUsage =
			selectedUser &&
			usageData &&
			usageData.stableUserId === selectedUser.stableUserId
				? usageData
				: null
		const usageMonthsAscending = selectedUsage
			? [...selectedUsage.monthUsage].reverse()
			: []

		// Re-seed the plan draft whenever a different user becomes selected so
		// the select always starts from that user's stored plan.
		if (selectedUser && selectedUser.stableUserId !== planDraftStableUserId) {
			planDraftStableUserId = selectedUser.stableUserId
			selectedPlanChoice = selectedUser.plan ?? 'free'
		}

		return (
			<AccountManagementShell>
				<AdminPageHeader
					title="Admin users"
					description="Review account metadata and manage role assignments and entitlement plans. User content is never shown here."
					currentHref={currentHref}
				/>
				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading users…
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
							title="Accounts"
							description="Select a user to review metadata and roles."
						>
							<div mix={css({ display: 'grid', gap: spacing.sm })}>
								<AccountManagementSearchField
									label="Search"
									placeholder="Search by username or email"
									value={filters.search}
									onInput={(value) => {
										replaceLocation(
											buildHrefWithUpdatedFilters({ search: value }),
										)
									}}
								/>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Role</span>
									<select
										data-field-ring
										value={filters.role}
										aria-label="Filter users by role"
										mix={[
											on('change', (event) => {
												replaceLocation(
													buildHrefWithUpdatedFilters({
														role: event.currentTarget.value,
													}),
												)
											}),
											css(selectCss),
										]}
									>
										<option value="">All roles</option>
										{availableRoles.map((role) => (
											<option key={role} value={role}>
												{role}
											</option>
										))}
									</select>
								</label>
							</div>
							{status === 'ready' && users.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									{hasActiveFilters
										? 'No users match the current filters.'
										: 'No users found.'}
								</p>
							) : (
								<>
									<AccountManagementList>
										{users.map((user) => (
											<li key={user.stableUserId} mix={css({ minWidth: 0 })}>
												<AccountManagementListItemButton
													active={selectedStableUserId === user.stableUserId}
													disabled={isMutating}
													onClick={() => {
														if (isMutating) return
														navigate(buildUserDetailHref(user.stableUserId))
													}}
												>
													<strong mix={css({ display: 'block' })}>
														{user.username}
													</strong>
													<span
														mix={css({
															display: 'block',
															fontSize: typography.fontSize.sm,
															color: colors.textMuted,
														})}
													>
														{user.email}
													</span>
													<span
														mix={css({
															display: 'block',
															fontSize: typography.fontSize.xs,
															color: colors.textMuted,
														})}
													>
														{user.roles.length > 0
															? user.roles.join(', ')
															: 'No roles'}
													</span>
												</AccountManagementListItemButton>
											</li>
										))}
										{hasMore ? (
											<li
												key="load-more-sentinel"
												mix={[
													infiniteScrollSentinel(loadMoreUsers),
													css({ display: 'grid' }),
												]}
											>
												<button
													type="button"
													disabled={isLoadingMore}
													mix={[
														on('click', () => void loadMoreUsers()),
														css(secondaryButtonCss),
													]}
												>
													{isLoadingMore ? 'Loading more…' : 'Load more'}
												</button>
											</li>
										) : null}
									</AccountManagementList>
									{usersSnapshot.error ? (
										<AccountManagementMessage tone="error">
											{usersSnapshot.error}
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
											Showing {users.length} of {totalCount}{' '}
											{totalCount === 1 ? 'account' : 'accounts'}
										</p>
									) : null}
								</>
							)}
						</AccountManagementSidebar>
					}
				>
					<div mix={css({ ...cardCss, gap: spacing.lg })}>
						{selectedUser ? (
							<>
								<div mix={css({ display: 'grid', gap: spacing.xs })}>
									<h2
										mix={css({
											margin: 0,
											fontSize: typography.fontSize.lg,
											fontWeight: typography.fontWeight.semibold,
										})}
									>
										{selectedUser.username}
									</h2>
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										Account metadata only — no secrets, packages, or other user
										content appears on this page.
									</p>
								</div>
								<MetadataGrid
									columns={3}
									items={[
										{ label: 'Email', value: selectedUser.email },
										{
											label: 'Email verified',
											value: selectedUser.email_verified
												? (selectedUser.email_verified_at ?? 'Verified')
												: 'No',
										},
										{
											label: 'Stable user id',
											value: selectedUser.stableUserId,
										},
										{
											label: 'Roles',
											value:
												selectedUser.roles.length > 0
													? selectedUser.roles.join(', ')
													: 'None',
										},
										{
											label: 'Plan',
											value: selectedUser.plan ?? 'free',
										},
										{
											label: 'Suspended',
											value: selectedUser.suspended_at
												? formatTimestamp(selectedUser.suspended_at)
												: 'No',
										},
										{
											label: 'Outbound email',
											value: selectedUser.email_outbound_paused_at
												? `Paused ${formatTimestamp(selectedUser.email_outbound_paused_at)}`
												: 'Active',
										},
										{
											label: 'Created',
											value: formatTimestamp(selectedUser.created_at),
										},
										{
											label: 'Updated',
											value: formatTimestamp(selectedUser.updated_at),
										},
									]}
								/>
								<AccountManagementPanel title="Manage roles">
									<div
										mix={css({
											display: 'grid',
											gap: spacing.md,
											gridTemplateColumns: 'minmax(0, 1fr) auto auto',
											alignItems: 'end',
											[mq.mobile]: { gridTemplateColumns: '1fr' },
										})}
									>
										<label mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>Role</span>
											<select
												data-field-ring
												value={selectedRoleToAssign}
												disabled={isMutating}
												aria-label="Role"
												mix={[
													on('change', (event) => {
														selectedRoleToAssign = event.currentTarget
															.value as RoleName
														handle.update()
													}),
													css(selectCss),
												]}
											>
												{availableRoles.map((role) => (
													<option key={role} value={role}>
														{role}
													</option>
												))}
											</select>
										</label>
										<button
											type="button"
											disabled={isMutating}
											mix={[
												on('click', () => void submitRoleAction('assign_role')),
												css(primaryButtonCss),
											]}
										>
											{actionState === 'assigning' ? 'Assigning…' : 'Assign'}
										</button>
										<button
											type="button"
											disabled={
												isMutating ||
												!selectedUser.roles.includes(selectedRoleToAssign)
											}
											mix={[
												on('click', () => void submitRoleAction('remove_role')),
												css(secondaryButtonCss),
											]}
										>
											{actionState === 'removing' ? 'Removing…' : 'Remove'}
										</button>
									</div>
								</AccountManagementPanel>
								<AccountManagementPanel title="Manage plan">
									<div
										mix={css({
											display: 'grid',
											gap: spacing.md,
											gridTemplateColumns: 'minmax(0, 1fr) auto',
											alignItems: 'end',
											[mq.mobile]: { gridTemplateColumns: '1fr' },
										})}
									>
										<label mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>Plan</span>
											<select
												data-field-ring
												disabled={isMutating}
												aria-label="Plan"
												mix={[
													on('change', (event) => {
														selectedPlanChoice = event.currentTarget
															.value as AdminPlanName
														handle.update()
													}),
													css(selectCss),
												]}
											>
												{availablePlans.map((plan) => (
													<option
														key={plan}
														value={plan}
														selected={plan === selectedPlanChoice}
													>
														{plan}
													</option>
												))}
											</select>
										</label>
										<button
											type="button"
											disabled={
												isMutating ||
												selectedPlanChoice === (selectedUser.plan ?? 'free')
											}
											mix={[
												on('click', () => void submitPlanAction()),
												css(primaryButtonCss),
											]}
										>
											{actionState === 'saving-plan' ? 'Saving…' : 'Save plan'}
										</button>
									</div>
								</AccountManagementPanel>
								<AccountManagementPanel
									title="Moderation"
									description="Suspension blocks the account at the session, MCP, and email chokepoints. The outbound-email pause is set automatically after spam complaints or repeated bounces."
								>
									<div
										mix={css({
											display: 'flex',
											gap: spacing.md,
											flexWrap: 'wrap',
										})}
									>
										{selectedUser.suspended_at ? (
											<button
												type="button"
												disabled={isMutating}
												mix={[
													on(
														'click',
														() => void submitModerationAction('unsuspend_user'),
													),
													css(primaryButtonCss),
												]}
											>
												{actionState === 'moderating'
													? 'Working…'
													: 'Clear suspension'}
											</button>
										) : (
											<button
												type="button"
												disabled={isMutating}
												mix={[
													on(
														'click',
														() => void submitModerationAction('suspend_user'),
													),
													css(secondaryButtonCss),
												]}
											>
												{actionState === 'moderating'
													? 'Working…'
													: 'Suspend account'}
											</button>
										)}
										{selectedUser.email_outbound_paused_at ? (
											<button
												type="button"
												disabled={isMutating}
												mix={[
													on(
														'click',
														() =>
															void submitModerationAction(
																'resume_email_outbound',
															),
													),
													css(secondaryButtonCss),
												]}
											>
												{actionState === 'moderating'
													? 'Working…'
													: 'Resume outbound email'}
											</button>
										) : null}
									</div>
								</AccountManagementPanel>
								<AccountManagementPanel
									title="Usage & quotas"
									description="Metered usage rollups and entitlement consumption for this account. Warnings appear above 80% of a numeric limit."
								>
									{!selectedUsage && usageStatus === 'loading' ? (
										<p mix={css({ margin: 0, color: colors.textMuted })}>
											Loading usage…
										</p>
									) : null}
									{usageStatus === 'error' &&
									usageFailedForStableUserId === selectedUser.stableUserId &&
									usageMessage ? (
										<AccountManagementMessage tone="error">
											{usageMessage}
										</AccountManagementMessage>
									) : null}
									{selectedUsage ? (
										<>
											{selectedUsage.warnings.length > 0 ? (
												<div mix={css(noticeCardCss)}>
													<strong>Quota watch:</strong>{' '}
													{selectedUsage.warnings
														.map(
															(item) =>
																`${item.label} at ${formatUsagePercent(item.percentOfLimit)}`,
														)
														.join(', ')}
												</div>
											) : null}
											<div mix={css({ display: 'grid', gap: spacing.md })}>
												<h3
													mix={css({
														margin: 0,
														fontSize: typography.fontSize.base,
													})}
												>
													Monthly activity
												</h3>
												<StackedBarChart
													id="admin-user-usage"
													ariaLabel={`Metered events by month for ${selectedUsage.username}`}
													series={usageMetricSeries.map((entry) => ({
														label: entry.label,
														color: entry.color,
														values: usageMonthsAscending.map(
															(month) =>
																month.usage.find(
																	(row) => row.metric === entry.metric,
																)?.eventCount ?? 0,
														),
													}))}
													xLabels={usageMonthsAscending.map((month) =>
														formatMonthKeyLabel(month.month),
													)}
													viewBoxWidth={560}
													height={200}
												/>
												<ChartLegend
													items={usageMetricSeries.map((entry) => ({
														label: entry.label,
														color: entry.color,
														value: formatIntegerNumber(
															selectedUsage.currentMonthUsage.find(
																(row) => row.metric === entry.metric,
															)?.eventCount ?? 0,
														),
													}))}
												/>
												<p
													mix={css({
														margin: 0,
														color: colors.textMuted,
														fontSize: typography.fontSize.xs,
													})}
												>
													Legend counts are for the current month (
													{selectedUsage.currentMonth}).
												</p>
											</div>
											<div mix={css({ display: 'grid', gap: spacing.md })}>
												<h3
													mix={css({
														margin: 0,
														fontSize: typography.fontSize.base,
													})}
												>
													Entitlements
												</h3>
												<div mix={css({ overflowX: 'auto' })}>
													<table mix={css(accountManagementTableCss)}>
														<thead>
															<tr>
																<th mix={css(accountManagementTableCellCss)}>
																	Resource
																</th>
																<th
																	mix={css(
																		accountManagementTableNumericCellCss,
																	)}
																>
																	In use
																</th>
																<th
																	mix={css(
																		accountManagementTableNumericCellCss,
																	)}
																>
																	Limit
																</th>
																<th
																	mix={css(
																		accountManagementTableNumericCellCss,
																	)}
																>
																	Used
																</th>
															</tr>
														</thead>
														<tbody>
															{selectedUsage.entitlementConsumption.map(
																(item) => (
																	<tr key={item.resource}>
																		<td
																			mix={css(accountManagementTableCellCss)}
																		>
																			{item.label}
																		</td>
																		<td
																			mix={css(
																				accountManagementTableNumericCellCss,
																			)}
																		>
																			{item.current === null
																				? 'Not measured'
																				: formatIntegerNumber(item.current)}
																		</td>
																		<td
																			mix={css(
																				accountManagementTableNumericCellCss,
																			)}
																		>
																			{formatUsageLimit(item.limit)}
																		</td>
																		<td
																			mix={css({
																				...accountManagementTableNumericCellCss,
																				...(item.overEightyPercent
																					? {
																							color: chartColor.amber,
																							fontWeight:
																								typography.fontWeight.semibold,
																						}
																					: {}),
																			})}
																		>
																			{formatUsagePercent(item.percentOfLimit)}
																		</td>
																	</tr>
																),
															)}
														</tbody>
													</table>
												</div>
											</div>
										</>
									) : null}
								</AccountManagementPanel>
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
									Select an account
								</h2>
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Pick an account from the list to view its details.
								</p>
							</div>
						)}
					</div>
				</AccountManagementLayout>
			</AccountManagementShell>
		)
	}
}
