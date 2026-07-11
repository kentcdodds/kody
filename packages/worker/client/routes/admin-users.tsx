import { formatTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { readRouterSearch } from '#client/router-location.tsx'
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

function buildUsersHref(handle: Handle, page: number) {
	const url = new URL(readCurrentRouterHref(handle), 'http://localhost')
	if (page <= 1) url.searchParams.delete('page')
	else url.searchParams.set('page', String(page))
	return `${url.pathname}${url.search}`
}

export async function adminUsersRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(`${adminUsersApiPath}${url.search}`, {
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
	let users: Array<AdminUserListItem> = []
	let availableRoles: Array<RoleName> = []
	let availablePlans: Array<AdminPlanName> = []
	let page = 1
	let pageSize = 20
	let total = 0
	let selectedUserId: number | null = null
	let message: string | null = null
	let actionState: 'idle' | 'assigning' | 'removing' | 'saving-plan' = 'idle'
	let selectedRoleToAssign = 'user' as RoleName
	// '' represents the NULL plan (legacy/unlimited). The draft follows the
	// selected user (see the render body) until the admin edits it.
	let selectedPlanChoice: AdminPlanName | '' = ''
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
		return users.find((user) => user.id === selectedUserId) ?? null
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
				`${adminUsersApiPath}${readRouterSearch(handle)}`,
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
			users = payload.users
			availableRoles = payload.availableRoles
			availablePlans = payload.availablePlans
			page = payload.page
			pageSize = payload.pageSize
			total = payload.total
			resetPlanDraft()
			lastLoadedHref = href
			if (
				selectedUserId != null &&
				!users.some((user) => user.id === selectedUserId)
			) {
				selectedUserId = users[0]?.id ?? null
			}
			if (selectedUserId == null && users.length > 0) {
				selectedUserId = users[0]?.id ?? null
			}
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
				AdminUsersLoaderData & { ok?: boolean; error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to update user roles.')
			}
			users = payload.users
			availableRoles = payload.availableRoles
			availablePlans = payload.availablePlans
			page = payload.page
			pageSize = payload.pageSize
			total = payload.total
			resetPlanDraft()
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
		const plan = selectedPlanChoice === '' ? null : selectedPlanChoice
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
				AdminUsersLoaderData & { ok?: boolean; error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to update user plan.')
			}
			users = payload.users
			availableRoles = payload.availableRoles
			availablePlans = payload.availablePlans
			page = payload.page
			pageSize = payload.pageSize
			total = payload.total
			resetPlanDraft()
			invalidateUsage()
			selectedUserId = selectedUser.id
			lastLoadedHref = readCurrentRouterHref(handle)
			message = `Updated plan to ${plan ?? 'legacy/unlimited'}.`
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
		users = routeData.users
		availableRoles = routeData.availableRoles
		availablePlans = routeData.availablePlans
		page = routeData.page
		pageSize = routeData.pageSize
		total = routeData.total
		resetPlanDraft()
		lastLoadedHref = href
		if (
			selectedUserId != null &&
			!users.some((user) => user.id === selectedUserId)
		) {
			selectedUserId = users[0]?.id ?? null
		}
		if (selectedUserId == null && users.length > 0) {
			selectedUserId = users[0]?.id ?? null
		}
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
		// Consume route-loader data before deriving `totalPages` and
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

		const totalPages = Math.max(1, Math.ceil(total / pageSize))
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
			selectedPlanChoice = selectedUser.plan ?? ''
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
							{status === 'ready' && users.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									No users found.
								</p>
							) : (
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
								</AccountManagementList>
							)}
							{totalPages > 1 ? (
								<div
									mix={css({
										display: 'flex',
										gap: spacing.sm,
										marginTop: spacing.md,
									})}
								>
									<button
										type="button"
										disabled={page <= 1 || isMutating}
										mix={[
											on('click', () =>
												navigate(buildUsersHref(handle, page - 1)),
											),
											css(secondaryButtonCss),
										]}
									>
										Previous
									</button>
									<span mix={css({ color: colors.textMuted })}>
										Page {page} of {totalPages}
									</span>
									<button
										type="button"
										disabled={page >= totalPages || isMutating}
										mix={[
											on('click', () =>
												navigate(buildUsersHref(handle, page + 1)),
											),
											css(secondaryButtonCss),
										]}
									>
										Next
									</button>
								</div>
							) : null}
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
											value: selectedUser.plan ?? 'Legacy/unlimited',
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
												value={selectedPlanChoice}
												disabled={isMutating}
												aria-label="Plan"
												mix={[
													on('change', (event) => {
														selectedPlanChoice = event.currentTarget.value as
															| AdminPlanName
															| ''
														handle.update()
													}),
													css(inputCss),
												]}
											>
												<option value="">Legacy/unlimited (no plan)</option>
												{availablePlans.map((plan) => (
													<option key={plan} value={plan}>
														{plan}
													</option>
												))}
											</select>
										</label>
										<button
											type="button"
											disabled={
												isMutating ||
												selectedPlanChoice === (selectedUser.plan ?? '')
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
