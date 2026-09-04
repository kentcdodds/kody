import { css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
import { AccountManagementPanel } from '#client/routes/account-management-components.tsx'

const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })

export function renderAccountLogoutPanel() {
	return (
		<AccountManagementPanel
			title="Session"
			description="Sign out of this browser. Your account and data stay intact."
		>
			<form
				method="post"
				action={routes.logout.href()}
				mix={css({ margin: 0 })}
			>
				<button type="submit" mix={css(compactGhostButtonCss)}>
					Log out
				</button>
			</form>
		</AccountManagementPanel>
	)
}
