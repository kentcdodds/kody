import { expect, test } from './playwright-utils.ts'
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
	await expect(
		page.getByRole('heading', {
			name: /When your agent figures it out,\s*Kody makes it permanent\./i,
		}),
	).toBeVisible()

	await page.goto('/account')
	await expect(page).toHaveURL(/\/login\?redirectTo=%2Faccount$/)
	await expect(page.getByLabel('Email')).toBeVisible()
	await expect(page.getByLabel('Password')).toBeVisible()

	clearAuthRateLimitsInE2eDatabase()
	await page.getByLabel('Email').fill(primaryTestUser.email)
	await page.getByLabel('Password').fill(primaryTestUser.password)
	await page.getByRole('button', { name: 'Sign in', exact: true }).click()

	await expect(page).toHaveURL(/\/account$/)
	// Scoped to the header, and exact so the lowercase test username ("kody")
	// does not also match the "Kody" brand links in the header and footer.
	await expect(
		page.getByRole('navigation', { name: 'Main' }).getByRole('link', {
			name: primaryTestUser.username,
			exact: true,
		}),
	).toBeVisible()
	await expect(
		page.getByRole('link', { name: 'Secrets', exact: true }),
	).toBeVisible()

	// SPA-navigate to secrets: the client refetch must hit the same origin
	// (regression: absolute placeholder-origin URLs caused "Failed to fetch").
	await page.getByRole('link', { name: 'Secrets', exact: true }).click()
	await expect(page).toHaveURL(/\/account\/secrets$/)
	// The list is a named region; it replaced the sidebar heading that used to
	// carry this name, and it is present whether or not the account has rows.
	await expect(
		page.getByRole('region', { name: 'Saved secrets', exact: true }),
	).toBeVisible()
	await expect(page.getByText('Failed to fetch')).not.toBeVisible()

	// Log out through the top nav. The router intercepts the form POST and
	// SPA-navigates to /login, so the shell must refresh its session state
	// without a full document reload (regression: the throttled refresh kept
	// the username and Log out button visible after logging out).
	await page.getByRole('button', { name: 'Log out' }).click()
	await expect(page).toHaveURL(/\/login$/)
	// The redesigned login screen renders without the site header, so the
	// logged-out state shows the auth card instead of a header "Log in" link.
	await expect(
		page.getByRole('heading', { name: 'Welcome back' }),
	).toBeVisible()
	await expect(page.getByRole('button', { name: 'Log out' })).not.toBeVisible()
	// Exact, so this asserts the username link is gone rather than tripping on
	// the "Kody" brand link that a case-insensitive match would also find.
	await expect(
		page.getByRole('link', { name: primaryTestUser.username, exact: true }),
	).not.toBeVisible()

	await page.goto('/privacy')
	await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible()
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
		page.getByRole('heading', { name: 'Standard', exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Pro', exact: true }),
	).toBeVisible()
})
