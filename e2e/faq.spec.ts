import { expect, test } from './playwright-utils.ts'

test('public FAQ page works logged out with native disclosures', async ({
	page,
}) => {
	await page.context().clearCookies()
	await page.goto('/faq')

	await expect(
		page.getByRole('heading', { name: /before you connect/i }),
	).toBeVisible()
	await expect(page).toHaveURL(/\/faq$/)

	const replaceAgents = page.locator('details[data-faq="replace-agents"]')
	await expect(replaceAgents).toBeVisible()
	await expect(replaceAgents.locator('summary')).toHaveText(
		'Does Kody replace Claude, Cursor, ChatGPT, or Codex?',
	)

	const sharedAccount = page.locator('details[data-faq="shared-account"]')
	await sharedAccount.locator('summary').click()
	await expect(sharedAccount).toHaveAttribute('open', '')
	await expect(
		page.getByText(
			'Your assistant is yours unless you publish a public package.',
		),
	).toBeVisible()

	await expect(
		page.getByRole('navigation', { name: 'Footer' }).getByRole('link', {
			name: 'FAQ',
			exact: true,
		}),
	).toBeVisible()

	await page.goto('/')
	await page
		.getByRole('navigation', { name: 'Footer' })
		.getByRole('link', { name: 'FAQ', exact: true })
		.click()
	await expect(page).toHaveURL(/\/faq$/)
	await expect(
		page.getByRole('heading', { name: /before you connect/i }),
	).toBeVisible()
})
