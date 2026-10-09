import { type Handle } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import {
	AccountManagementShell,
	AccountPageHeader,
} from '#client/routes/account-management-components.tsx'
import { ProfileRoute } from '#client/routes/profile.tsx'

/**
 * The workspace's repository list (`/@slug/packages`), in the workspace rail.
 * The public profile at `/@slug` lists the same repositories for visitors.
 */
export function AccountRepositoriesRoute(handle: Handle) {
	return () => (
		<AccountManagementShell>
			<AccountPageHeader
				title="Repositories"
				description="Every repository in this workspace, private ones included. Your public profile shows visitors the public ones."
				currentHref={readCurrentRouterHref(handle)}
			/>
			<ProfileRoute />
		</AccountManagementShell>
	)
}
