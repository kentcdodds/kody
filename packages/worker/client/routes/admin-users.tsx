import { formatTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { readRouterSearch } from '#client/router-location.tsx'
import { replaceLocation } from '#client/replace-location.ts'
import {
	createInfiniteList,
	type InfiniteListSnapshot,
} from '#client/infinite-list.ts'
import { infiniteScrollSentinel } from '#client/infinite-scroll.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, mq, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
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
import { type RoleName } from '#app/permissions.ts'
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

type AccountStatus = 'loading' | 'ready' | 'error'
type UsageStatus = 'loading' | 'ready' | 'error'

const adminUsersApiPath = '/admin/users.json'
const adminUserUsageApiPath = '/admin/users/usage.json'

function formatUsageLimit(limit: number | null) {
	return limit === null ? 'Unlimited' : formatIntegerNumber(limit)
}

function formatUsagePercent(value: number | null) {
	if (value === null) return '—'
	return `${Math.round(value * 100)}%`
}

function isAdminUsersPath(href: string) {
	const path = new URL(href, 'http://localhost').pathname
	return path === '/admin/users' || path === '/admin'
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
 * Initial loads must anchor the window at page 1 — seeding from a stale
 * `?page=N` link would leave every earlier page unreachable because
 * infinite scroll only appends later pages.
 */
function stripPageParam(search: string) {
	const params = new URLSearchParams(search)
	params.delete('page')
	const next = params.toString()
	return next ? `?${next}` : ''
}

export async function adminUsersRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(
		`${adminUsersApiPath}${stripPageParam(url.search)}`,
		{
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		},
	)
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
		getKey: (user) => String(user.id),
		onSnapshot: (snapshot) => {
			usersSnapshot = snapshot
		},
	})
	let usersSnapshot: InfiniteListSnapshot<AdminUserListItem> =
		userList.getSnapshot()
	let selectedUserId: number | null = null
	let message: string | null = null
	let actionState: 'idle' | 'assigning' | 'removing' | 'saving-plan' = 'idle'
	let selectedRoleToAssign = 'user' as RoleName
	// Draft follows the selected user (see the render body) until the admin
	// edits it. Null stored plan values are shown/saved as `unlimited`.
	let selectedPlanChoice: AdminPlanName = 'unlimited'
	let planDraftUserId: number | null = null
	let loadRequestId = 0
	let lastLoadedHref = ''
	let loadingForHref: string | null = null
	let lastFailedHref: string | null = null
	let usageStatus: UsageStatus = 'loading'
	let usageData: AdminUserUsageLoaderData | null = null
	let usageMessage: string | null = null
	let usageRequestId = 0
	let usageLoadedForUserId: number | null = null
	let usageLoadingForUserId: number | null = null
	let usageFailedForUserId: number | null = null

	function getSelectedUser() {
		return (
			usersSnapshot.items.find((user) => user.id === selectedUserId) ?? null
		)
	}

	function ensureSelection() {
		const users = usersSnapshot.items
		if (
			selectedUserId != null &&
			!users.some((user) => user.id === selectedUserId)
		) {
			selectedUserId = users[0]?.id ?? null
		}
		if (selectedUserId == null && users.length > 0) {
			selectedUserId = users[0]?.id ?? null
		}
	}

	function seedUsersFromPayload(payload: AdminUsersLoaderData) {
		availableRoles = payload.availableRoles
		availablePlans = payload.availablePlans
		loadedThroughPage = payload.page
		// reset() invalidates any in-flight load-more so a stale page fetched
		// for the previous filters can never append into the fresh window.
		userList.reset()
		userList.replaceWindow({
			items: payload.users,
			hasMore: payload.page * payload.pageSize < payload.total,
			totalCount: payload.total,
		})
		resetPlanDraft()
		ensureSelection()
	}

	function buildHrefWithUpdatedFilters(
		nextFilters: Partial<AdminUserFilterState>,
	) {
		const url = new URL(readCurrentRouterHref(handle), 'http://localhost')
		const filters = { ...readFilterState(url.toString()), ...nextFilters }
		if (filters.search) url.searchParams.set('q', filters.search)
		else url.searchParams.delete('q')
		if (filters.role) url.searchParams.set('role', filters.role)
		else url.searchParams.delete('role')
		// Filter changes re-anchor the list at the first page.
		url.searchParams.delete('page')
		return `${url.pathname}${url.search}`
	}

	async function loadUserUsage(userId: number) {
		usageLoadingForUserId = userId
		const requestId = ++usageRequestId
		try {
			const response = await fetch(
				`${adminUserUsageApiPath}?userId=${userId}`,
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
			usageLoadedForUserId = userId
			usageFailedForUserId = null
			handle.update()
		} catch (error) {
			if (requestId !== usageRequestId) return
			usageStatus = 'error'
			usageMessage =
				error instanceof Error
					? error.message
					: 'Unable to load usage for this account.'
			usageFailedForUserId = userId
			handle.update()
		} finally {
			if (requestId === usageRequestId) usageLoadingForUserId = null
		}
	}

	// Plan changes move entitlement limits, so the drill-down must refetch
	// even though the selected user did not change. Dropping the cached data
	// keeps stale limits from rendering while the refetch is in flight.
	function invalidateUsage() {
		usageData = null
		usageLoadedForUserId = null
		usageFailedForUserId = null
	}

	// Any refresh of `users` may carry a newer stored plan, so drop the
	// unsaved draft and let the render pass reseed the select from the
	// refreshed record.
	function resetPlanDraft() {
		planDraftUserId = null
	}

	async function loadAdminUsers() {
		const href = readCurrentRouterHref(handle)
		loadingForHref = href
		const requestId = ++loadRequestId
		try {
			const response = await fetch(
				`${adminUsersApiPath}${stripPageParam(readRouterSearch(handle))}`,
				{ headers: { Accept: 'application/json' }, credentials: 'include' },
			)
			if (requestId !== loadRequestId) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			if (response.status === 403) {
				status = 'error'
				message = 'You do not have permission to view admin users.'
				lastFailedHref = href
				handle.update()
				return
			}
			const payload = await readJson<AdminUsersLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load admin users.')
			}
			seedUsersFromPayload(payload)
			lastLoadedHref = href
			status = 'ready'
			message = null
			lastFailedHref = null
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load admin users.'
			lastFailedHref = href
			handle.update()
		} finally {
			if (requestId === loadRequestId) loadingForHref = null
		}
	}

	async function loadMoreUsers() {
		if (status !== 'ready') return false
		const nextPage = loadedThroughPage + 1
		const loaded = await userList.loadMore(async () => {
			const url = new URL(readCurrentRouterHref(handle), 'http://localhost')
			url.searchParams.set('page', String(nextPage))
			const response = await fetch(`${adminUsersApiPath}${url.search}`, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
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
	 * selection instead of resetting to the first page. A role change can
	 * knock the target out of the active role filter, so drop rows that no
	 * longer match and take the refreshed filtered total from the server.
	 */
	function applyMutationPayload(payload: AdminUsersMutationData) {
		availableRoles = payload.availableRoles
		availablePlans = payload.availablePlans
		const updatedUser = payload.updatedUser
		const { role } = readFilterState(readCurrentRouterHref(handle))
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
						item.id === updatedUser.id ? updatedUser : item,
					)
				: currentItems.filter((item) => item.id !== updatedUser.id)
			: currentItems
		// reset() invalidates any in-flight load-more so a page fetched before
		// the mutation cannot merge stale rows or counts back in afterward.
		userList.reset()
		userList.replaceWindow({
			items: nextItems,
			hasMore: nextItems.length < payload.total,
			totalCount: payload.total,
		})
		resetPlanDraft()
		ensureSelection()
	}

	async function submitRoleAction(action: 'assign_role' | 'remove_role') {
		const selectedUser = getSelectedUser()
		if (!selectedUser || actionState !== 'idle') return
		actionState = action === 'assign_role' ? 'assigning' : 'removing'
		message = null
		handle.update()
		try {
			// Carry the current query string so the server rebuilds the same
			// page/pageSize slice the user is viewing, not page one.
			const search = new URL(readCurrentRouterHref(handle), 'http://localhost')
				.search
			const response = await fetch(`${adminUsersApiPath}${search}`, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action,
					userId: selectedUser.id,
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
			applyMutationPayload(payload)
			selectedUserId = selectedUser.id
			lastLoadedHref = readCurrentRouterHref(handle)
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
		const selectedUser = getSelectedUser()
		if (!selectedUser || actionState !== 'idle') return
		const plan = selectedPlanChoice
		actionState = 'saving-plan'
		message = null
		handle.update()
		try {
			// Carry the current query string so the server rebuilds the same
			// page/pageSize slice the user is viewing, not page one.
			const search = new URL(readCurrentRouterHref(handle), 'http://localhost')
				.search
			const response = await fetch(`${adminUsersApiPath}${search}`, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'update_plan',
					userId: selectedUser.id,
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
			applyMutationPayload(payload)
			invalidateUsage()
			selectedUserId = selectedUser.id
			lastLoadedHref = readCurrentRouterHref(handle)
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

	const primaryButtonCss = getPrimaryButtonCss()
	const secondaryButtonCss = getSecondaryButtonCss()

	function applyRouteLoaderData(href: string) {
		if (!isAdminUsersPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'adminUsers', href)
		if (!routeData) return false
		seedUsersFromPayload(routeData)
		lastLoadedHref = href
		status = 'ready'
		message = null
		lastFailedHref = null
		return true
	}

	let lastSeenHref = ''

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		// The failure latch only guards retry loops for the location that
		// failed; leaving it (or coming back) must allow a fresh attempt.
		if (currentHref !== lastSeenHref) {
			lastSeenHref = currentHref
			lastFailedHref = null
		}
		// Consume route-loader data before deriving the list snapshot and
		// `selectedUser`; deriving first would render this pass from the
		// stale pre-navigation closure state.
		const appliedRouteData = applyRouteLoaderData(currentHref)
		// A same-path refresh whose loader failed leaves no preload and no
		// href change; the stale marker forces the fallback refetch.
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad =
			(status === 'loading' ||
				currentHref !== lastLoadedHref ||
				needsStaleRefresh) &&
			currentHref !== lastFailedHref &&
			loadingForHref !== currentHref
		if (!appliedRouteData && needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			loadingForHref = currentHref
			handle.queueTask(loadAdminUsers)
		}

		const { items: users, hasMore, totalCount, isLoadingMore } = usersSnapshot
		const filters = readFilterState(currentHref)
		const hasActiveFilters = Boolean(filters.search || filters.role)
		const selectedUser = getSelectedUser()
		const isMutating = actionState !== 'idle'

		if (
			selectedUser &&
			typeof document !== 'undefined' &&
			usageLoadedForUserId !== selectedUser.id &&
			usageLoadingForUserId !== selectedUser.id &&
			usageFailedForUserId !== selectedUser.id
		) {
			usageStatus = 'loading'
			usageLoadingForUserId = selectedUser.id
			const usageUserId = selectedUser.id
			handle.queueTask(() => loadUserUsage(usageUserId))
		}
		// Never render one account's usage under another account's header
		// while the drill-down request is still in flight.
		const selectedUsage =
			selectedUser && usageData && usageData.userId === selectedUser.id
				? usageData
				: null
		const usageMonthsAscending = selectedUsage
			? [...selectedUsage.monthUsage].reverse()
			: []

		// Re-seed the plan draft whenever a different user becomes selected so
		// the select always starts from that user's stored plan.
		if (selectedUser && selectedUser.id !== planDraftUserId) {
			planDraftUserId = selectedUser.id
			selectedPlanChoice = selectedUser.plan ?? 'unlimited'
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
											css(inputCss),
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
									<AccountManagementList maxHeight="min(65vh, 48rem)">
										{users.map((user) => (
											<li key={user.id} mix={css({ minWidth: 0 })}>
												<AccountManagementListItemButton
													active={selectedUserId === user.id}
													disabled={isMutating}
													onClick={() => {
														if (isMutating) return
														selectedUserId = user.id
														message = null
														handle.update()
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
										{ label: 'User id', value: String(selectedUser.id) },
										{
											label: 'Roles',
											value:
												selectedUser.roles.length > 0
													? selectedUser.roles.join(', ')
													: 'None',
										},
										{
											label: 'Plan',
											value: selectedUser.plan ?? 'unlimited',
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
												value={selectedRoleToAssign}
												disabled={isMutating}
												aria-label="Role"
												mix={[
													on('change', (event) => {
														selectedRoleToAssign = event.currentTarget
															.value as RoleName
														handle.update()
													}),
													css(inputCss),
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
												disabled={isMutating}
												aria-label="Plan"
												mix={[
													on('change', (event) => {
														selectedPlanChoice = event.currentTarget
															.value as AdminPlanName
														handle.update()
													}),
													css(inputCss),
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
												selectedPlanChoice ===
													(selectedUser.plan ?? 'unlimited')
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
									title="Usage & quotas"
									description="Metered usage rollups and entitlement consumption for this account. Warnings appear above 80% of a numeric limit."
								>
									{!selectedUsage && usageStatus === 'loading' ? (
										<p mix={css({ margin: 0, color: colors.textMuted })}>
											Loading usage…
										</p>
									) : null}
									{usageStatus === 'error' &&
									usageFailedForUserId === selectedUser.id &&
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
							<p mix={css({ margin: 0, color: colors.textMuted })}>
								Choose an account from the list to review metadata and roles.
							</p>
						)}
					</div>
				</AccountManagementLayout>
			</AccountManagementShell>
		)
	}
}
