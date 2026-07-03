import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { navigate, listenToRouterNavigation } from '#client/client-router.tsx'
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
	AccountManagementHeader,
	AccountManagementLayout,
	AccountManagementList,
	AccountManagementListItemButton,
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountManagementSidebar,
	MetadataGrid,
} from './account-management-components.tsx'
import { type RoleName } from '#app/permissions.ts'

type AccountStatus = 'loading' | 'ready' | 'error'

type AdminUserListItem = {
	id: number
	username: string
	email: string
	created_at: string
	updated_at: string
	roles: Array<RoleName>
}

type AdminUsersPayload = {
	ok: true
	users: Array<AdminUserListItem>
	page: number
	pageSize: number
	total: number
	availableRoles: Array<RoleName>
}

const adminUsersApiPath = '/admin/users.json'

function formatTimestamp(value: string) {
	return new Date(value).toLocaleString()
}

function getCurrentHref() {
	return typeof window === 'undefined' ? '/admin/users' : window.location.href
}

function buildUsersHref(page: number) {
	const url = new URL(getCurrentHref(), 'http://localhost')
	if (page <= 1) url.searchParams.delete('page')
	else url.searchParams.set('page', String(page))
	return `${url.pathname}${url.search}`
}

export function AdminUsersRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let users: Array<AdminUserListItem> = []
	let availableRoles: Array<RoleName> = []
	let page = 1
	let pageSize = 20
	let total = 0
	let selectedUserId: number | null = null
	let message: string | null = null
	let actionState: 'idle' | 'assigning' | 'removing' = 'idle'
	let selectedRoleToAssign = 'user' as RoleName
	let loadRequestId = 0
	let lastLoadedHref = ''

	function getSelectedUser() {
		return users.find((user) => user.id === selectedUserId) ?? null
	}

	async function loadAdminUsers() {
		const href = getCurrentHref()
		const requestId = ++loadRequestId
		try {
			const response = await fetch(
				`${adminUsersApiPath}${new URL(href).search}`,
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
				handle.update()
				return
			}
			const payload = await readJson<AdminUsersPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load admin users.')
			}
			users = payload.users
			availableRoles = payload.availableRoles
			page = payload.page
			pageSize = payload.pageSize
			total = payload.total
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
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load admin users.'
			handle.update()
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
			const search = new URL(getCurrentHref(), 'http://localhost').search
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
				AdminUsersPayload & { ok?: boolean; error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || 'Unable to update user roles.')
			}
			users = payload.users
			availableRoles = payload.availableRoles
			page = payload.page
			pageSize = payload.pageSize
			total = payload.total
			selectedUserId = selectedUser.id
			lastLoadedHref = getCurrentHref()
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

	const primaryButtonCss = getPrimaryButtonCss()
	const secondaryButtonCss = getSecondaryButtonCss()

	handle.queueTask(() => {
		listenToRouterNavigation(handle, () => {
			const nextHref = getCurrentHref()
			if (nextHref !== lastLoadedHref && status !== 'loading') {
				status = 'loading'
				handle.update()
			}
		})
	})

	return () => {
		const currentHref = getCurrentHref()
		const totalPages = Math.max(1, Math.ceil(total / pageSize))
		const selectedUser = getSelectedUser()
		const isMutating = actionState !== 'idle'

		if (status === 'loading' || currentHref !== lastLoadedHref) {
			handle.queueTask(loadAdminUsers)
		}

		return (
			<AccountManagementShell>
				<AccountManagementHeader
					title="Admin users"
					description="Review account metadata and manage role assignments. User content is never shown here."
					actions={
						<a
							href="/admin/roles"
							mix={css({ ...secondaryButtonCss, textDecoration: 'none' })}
						>
							View roles
						</a>
					}
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
											on('click', () => navigate(buildUsersHref(page - 1))),
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
											on('click', () => navigate(buildUsersHref(page + 1))),
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
										{ label: 'User id', value: String(selectedUser.id) },
										{
											label: 'Roles',
											value:
												selectedUser.roles.length > 0
													? selectedUser.roles.join(', ')
													: 'None',
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
