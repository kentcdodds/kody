import { type Handle, css } from 'remix/ui'
import { createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
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
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
import { isStalledEmailVerificationDelivery } from '#universal/email-verification-delivery.ts'
import { type RoleName } from '#universal/permissions.ts'
import {
	type AdminPlanName,
	type AdminUserListItem,
	type AdminUsersLoaderData,
	type AdminUsersMutationData,
	type AdminUserUsageLoaderData,
} from '#universal/loader-data.ts'
import {
	type AdminUserFilterState,
	adminUserUsageApiPath,
	buildAdminUsersApiRequestUrl,
	buildFilteredListHref,
	buildUserDetailHrefFrom,
	getDataKey,
	getListKey,
	getSelection,
	isAdminUsersPath,
	parseSelectedStableUserId,
	readFilterState,
} from './admin-users-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import {
	RecordChips,
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordCellClamp,
} from './record-table.tsx'
import {
	type AdminUsersActionState,
	renderAdminUserDetail,
} from './admin-users-detail.tsx'

export { adminUsersRouteLoader } from './admin-users-shared.ts'

const clampedCellCss = css(recordCellClamp(28))

type AccountStatus = 'loading' | 'ready' | 'error'
type UsageStatus = 'loading' | 'ready' | 'error'

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
	let actionState: AdminUsersActionState = 'idle'
	let mintedVerifyUrl: string | null = null
	let mintedVerifyUrlForStableUserId: string | null = null
	const markVerifiedCheck = createDoubleCheck(handle)
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
		return buildFilteredListHref(getCurrentHref(), nextFilters)
	}

	function buildUserDetailHref(stableUserId: string) {
		return buildUserDetailHrefFrom(getCurrentHref(), stableUserId)
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
		const { role, verification } = readFilterState(href)
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
		const matchesVerificationFilter =
			!updatedUser ||
			verification !== 'stalled' ||
			isStalledEmailVerificationDelivery({
				emailVerified: updatedUser.email_verified,
				delivery: updatedUser.email_verification_delivery,
			})
		const matchesActiveFilters = matchesRoleFilter && matchesVerificationFilter
		const currentItems = usersSnapshot.items
		const nextItems = updatedUser
			? matchesActiveFilters
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
			message = `Updated admin grant to ${plan}.`
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

	async function submitVerificationAction(
		action: 'mark_email_verified' | 'mint_verify_url',
	) {
		const href = getCurrentHref()
		const selectedUser = resolveSelectedUser(href)
		if (!selectedUser || actionState !== 'idle') return
		actionState = 'verifying'
		message = null
		handle.update()
		try {
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
				throw new Error(payload?.error || 'Unable to update verification.')
			}
			applyMutationPayload(payload, href)
			lastLoadedDataKey = getDataKey(href)
			if (action === 'mint_verify_url' && payload.verifyUrl) {
				mintedVerifyUrl = payload.verifyUrl
				mintedVerifyUrlForStableUserId = selectedUser.stableUserId
				message =
					'Minted a one-time verify link. Send it over a path that is not kody.codes.'
			} else {
				mintedVerifyUrl = null
				mintedVerifyUrlForStableUserId = null
				message = 'Marked email verified.'
			}
			status = 'ready'
			actionState = 'idle'
			handle.update()
		} catch (error) {
			actionState = 'idle'
			message =
				error instanceof Error
					? error.message
					: 'Unable to update verification.'
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
		const hasActiveFilters = Boolean(
			filters.search || filters.role || filters.verification,
		)
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
				{status === 'loading' && lastLoadedDataKey === '' ? (
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
				{usersSnapshot.error ? (
					<AccountManagementMessage tone="error">
						{usersSnapshot.error}
					</AccountManagementMessage>
				) : null}
				<RecordTable
					mode="expand"
					busy={status === 'loading'}
					ariaLabel="User accounts"
					selectedId={selectedStableUserId}
					// Unconditional: the snapshot keeps the previous window during a
					// refetch, and dropping the slot mid-refetch resized the search
					// field the reader is typing into.
					countLabel={`${users.length} of ${totalCount} ${totalCount === 1 ? 'account' : 'accounts'}`}
					emptyLabel={
						status === 'ready'
							? hasActiveFilters
								? 'No users match the current filters.'
								: 'No users found.'
							: 'Loading users…'
					}
					toolbar={
						<>
							<RecordTableSearch
								label="Search users"
								placeholder="Search by username or email"
								value={filters.search}
								onInput={(value) => {
									replaceLocation(
										buildHrefWithUpdatedFilters({ search: value }),
									)
								}}
							/>
							<RecordTableSelect
								label="Filter users by role"
								value={filters.role}
								onChange={(value) => {
									replaceLocation(buildHrefWithUpdatedFilters({ role: value }))
								}}
							>
								<option value="">All roles</option>
								{availableRoles.map((role) => (
									<option key={role} value={role}>
										{role}
									</option>
								))}
							</RecordTableSelect>
							<RecordTableSelect
								label="Filter users by verification"
								value={filters.verification}
								onChange={(value) => {
									replaceLocation(
										buildHrefWithUpdatedFilters({
											verification: value === 'stalled' ? 'stalled' : '',
										}),
									)
								}}
							>
								<option value="">All verification</option>
								<option value="stalled">Stalled accepted</option>
							</RecordTableSelect>
						</>
					}
					columns={[
						{ key: 'username', label: 'Username', primary: true },
						{ key: 'email', label: 'Email', drop: 1 },
						{ key: 'roles', label: 'Roles', drop: 2 },
					]}
					rows={users.map((user) => ({
						id: user.stableUserId,
						// A role or plan mutation is in flight against the selected
						// user; navigating away mid-write would strand it.
						href: isMutating
							? undefined
							: buildUserDetailHref(user.stableUserId),
						cells: {
							username: user.username,
							email: <span mix={clampedCellCss}>{user.email}</span>,
							roles: <RecordChips items={user.roles} empty="No roles" />,
						},
					}))}
					footer={
						hasMore ? (
							<div mix={infiniteScrollSentinel(loadMoreUsers)}>
								<button
									type="button"
									disabled={isLoadingMore}
									mix={[
										on('click', () => void loadMoreUsers()),
										css({ ...secondaryButtonCss, width: '100%' }),
									]}
								>
									{isLoadingMore ? 'Loading more…' : 'Load more'}
								</button>
							</div>
						) : null
					}
					record={
						selectedUser
							? renderAdminUserDetail({
									selectedUser,
									availableRoles,
									availablePlans,
									actionState,
									selectedRoleToAssign,
									selectedPlanChoice,
									mintedVerifyUrl,
									mintedVerifyUrlForStableUserId,
									markVerifiedCheck,
									usageStatus,
									usageMessage,
									usageFailedForStableUserId,
									selectedUsage,
									onRoleToAssignChange: (role) => {
										selectedRoleToAssign = role
										handle.update()
									},
									onSubmitRoleAction: (action) => void submitRoleAction(action),
									onSubmitVerificationAction: (action) =>
										void submitVerificationAction(action),
									onPlanChoiceChange: (plan) => {
										selectedPlanChoice = plan
										handle.update()
									},
									onSubmitPlanAction: () => void submitPlanAction(),
									onSubmitModerationAction: (action) =>
										void submitModerationAction(action),
								})
							: null
					}
				/>
			</AccountManagementShell>
		)
	}
}
