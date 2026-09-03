import { expect, test } from './playwright-utils.ts'

test('public support page works logged out', async ({ page }) => {
	await page.context().clearCookies()
	await page.goto('/support')

	await expect(page.getByRole('heading', { name: 'Support' })).toBeVisible()
	await expect(page).toHaveURL(/\/support$/)
	await expect(
		page.getByRole('link', { name: 'support@kody.codes', exact: true }),
	).toHaveAttribute('href', 'mailto:support@kody.codes')
	await expect(
		page.getByText(/try the same request with a better model/i),
	).toBeVisible()
	await expect(page.getByText(/other deployments/i)).not.toBeVisible()

	await expect(
		page.getByRole('navigation', { name: 'Footer' }).getByRole('link', {
			name: 'Support',
			exact: true,
		}),
	).toBeVisible()

	await page.goto('/')
	await page
		.getByRole('navigation', { name: 'Footer' })
		.getByRole('link', { name: 'Support', exact: true })
		.click()
	await expect(page).toHaveURL(/\/support$/)
	await expect(page.getByRole('heading', { name: 'Support' })).toBeVisible()
})
