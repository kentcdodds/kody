import { type Handle, css } from 'remix/ui'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import { getSecondaryButtonCss } from '#client/styles/style-primitives.ts'
import {
	AccountManagementHeader,
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
} from './account-management-components.tsx'
import { type PermissionString } from '#app/permissions.ts'

type AccountStatus = 'loading' | 'ready' | 'error'

type AdminRoleListItem = {
	name: string
	description: string
	permissions: Array<PermissionString>
}

type AdminRolesPayload = {
	ok: true
	roles: Array<AdminRoleListItem>
}

const adminRolesApiPath = '/admin/roles.json'

export function AdminRolesRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let roles: Array<AdminRoleListItem> = []
	let message: string | null = null
	let loadRequestId = 0

	async function loadAdminRoles() {
		const requestId = ++loadRequestId
		try {
			const response = await fetch(adminRolesApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (requestId !== loadRequestId) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			if (response.status === 403) {
				status = 'error'
				message = 'You do not have permission to view admin roles.'
				handle.update()
				return
			}
			const payload = await readJson<AdminRolesPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load admin roles.')
			}
			roles = payload.roles
			status = 'ready'
			message = null
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load admin roles.'
			handle.update()
		}
	}

	const secondaryButtonCss = getSecondaryButtonCss()

	return () => {
		if (status === 'loading') handle.queueTask(loadAdminRoles)

		return (
			<AccountManagementShell>
				<AccountManagementHeader
					title="Admin roles"
					description="Read-only view of roles and the permissions attached to each."
					actions={
						<a
							href="/admin/users"
							mix={css({ ...secondaryButtonCss, textDecoration: 'none' })}
						>
							View users
						</a>
					}
				/>
				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading roles…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={status === 'error' ? 'error' : 'info'}
					>
						{message}
					</AccountManagementMessage>
				) : null}
				<div mix={css({ display: 'grid', gap: spacing.lg })}>
					{roles.map((role) => (
						<AccountManagementPanel
							key={role.name}
							title={role.name}
							description={role.description || 'No description provided.'}
						>
							<ul
								mix={css({
									margin: 0,
									paddingLeft: spacing.lg,
									display: 'grid',
									gap: spacing.xs,
								})}
							>
								{role.permissions.map((permission) => (
									<li key={permission}>
										<code mix={css({ fontSize: typography.fontSize.sm })}>
											{permission}
										</code>
									</li>
								))}
							</ul>
						</AccountManagementPanel>
					))}
				</div>
			</AccountManagementShell>
		)
	}
}
