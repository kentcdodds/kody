import { expect, test, waitForClientHydration } from './playwright-utils.ts'
import { ensurePrimaryUserExists, primaryTestUser } from './auth-test-user.ts'
import { clearAuthRateLimitsInE2eDatabase } from './d1-utils.ts'

test('smoke test covers shell, auth redirect, and login', async ({ page }) => {
	await ensurePrimaryUserExists()
	await page.context().clearCookies()

	await page.goto('/')
	// The redesigned header has no "Home" link — the brand mark is the link
	// home, so this is scoped to the header because the footer carries its own
	// "Kody" brand link. The headline assertion goes with it, so the test
	// covers the landing page rendering and not just the shell mounting.
	await expect(
		page.getByRole('navigation', { name: 'Main' }).getByRole('link', {
			name: 'Kody',
		}),
	).toBeVisible()
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

	await page.goto('/account')
	await expect(page).toHaveURL(/\/login\?redirectTo=%2Faccount$/)
	await waitForClientHydration(page)
	await expect(page.getByLabel('Email')).toBeVisible()
	// exact: the Show password toggle's aria-label also contains "password".
	const passwordField = page.getByLabel('Password', { exact: true })
	await expect(passwordField).toBeVisible()
	const showPassword = page.getByRole('button', {
		name: 'Show password',
		exact: true,
	})
	await expect(showPassword).toBeVisible()
	await expect(showPassword).toHaveAttribute('aria-pressed', 'false')
	await expect(passwordField).toHaveAttribute('type', 'password')

	clearAuthRateLimitsInE2eDatabase()
	await page.getByLabel('Email').fill(primaryTestUser.email)
	await passwordField.fill(primaryTestUser.password)
	await showPassword.click()
	await expect(
		page.getByRole('button', { name: 'Hide password', exact: true }),
	).toHaveAttribute('aria-pressed', 'true')
	await expect(passwordField).toHaveAttribute('type', 'text')
	await expect(passwordField).toHaveValue(primaryTestUser.password)
	await page.getByRole('button', { name: 'Hide password', exact: true }).click()
	await expect(passwordField).toHaveAttribute('type', 'password')
	await page.getByRole('button', { name: 'Sign in', exact: true }).click()

	await expect(page).toHaveURL(/\/account$/)
	// One header menu holds the organization and the person's own links; the
	// workspace sections are a click away from the Profile page.
	await expect(
		page.getByRole('heading', { level: 1, name: 'Profile' }),
	).toBeVisible()
	await expect(page.getByTestId('org-switcher')).toHaveAccessibleName(
		`@${primaryTestUser.username}: organizations and account`,
	)
	await page.goto('/account/jobs')
	await waitForClientHydration(page)
	const workspaceRail = page.getByRole('navigation', {
		name: 'Workspace sections',
	})
	await expect(
		workspaceRail.getByRole('link', { name: 'Secrets', exact: true }),
	).toBeVisible()

	// SPA-navigate to secrets: the client refetch must hit the same origin
	// (regression: absolute placeholder-origin URLs caused "Failed to fetch").
	await workspaceRail
		.getByRole('link', { name: 'Secrets', exact: true })
		.click()
	await expect(page).toHaveURL(
		new RegExp(`/@${primaryTestUser.username}/-/secrets$`),
	)
	// The list is a named region; it replaced the sidebar heading that used to
	// carry this name, and it is present whether or not the account has rows.
	await expect(
		page.getByRole('region', { name: 'Saved secrets', exact: true }),
	).toBeVisible()
	await expect(page.getByText('Failed to fetch')).not.toBeVisible()

	// Log out from the header menu. The router intercepts the form POST and
	// SPA-navigates to /login, so the shell must refresh its session state
	// without a full document reload (regression: the throttled refresh kept
	// the username and Log out button visible after logging out).
	await page.goto('/account')
	await expect(page).toHaveURL(/\/account$/)
	await expect(page.getByRole('region', { name: 'Session' })).toHaveCount(0)
	await waitForClientHydration(page)
	await page.getByTestId('org-switcher').click()
	await page
		.getByTestId('org-switcher-panel')
		.getByRole('button', { name: 'Log out' })
		.click()
	await expect(page).toHaveURL(/\/login$/)
	// The redesigned login screen renders without the site header, so the
	// logged-out state shows the auth card instead of a header "Log in" link.
	await expect(
		page.getByRole('heading', { name: 'Welcome back' }),
	).toBeVisible()
	await expect(page.getByRole('button', { name: 'Log out' })).not.toBeVisible()
	await expect(
		page.getByRole('link', {
			name: `@${primaryTestUser.username}`,
		}),
	).not.toBeVisible()

	await page.goto('/privacy')
	await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Connected accounts' }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Google user data' }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'What a deployment admin can see' }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'What an admin can never see' }),
	).toBeVisible()

	await page.goto('/pricing')
	await expect(
		page.getByRole('heading', { name: 'Free', exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Pro', exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Standard', exact: true }),
	).toHaveCount(0)
	await expect(
		page.getByRole('heading', { name: 'Prepaid credits', exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Teams / Enterprise', exact: true }),
	).toBeVisible()
})
