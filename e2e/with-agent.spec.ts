import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('homepage agent marquee links an agent to its /with page', async ({
	page,
}) => {
	await page.goto('/')
	await waitForClientHydration(page)
	const marquee = page.getByRole('navigation', {
		name: 'Agents that work with Kody',
	})
	await marquee.hover()
	await marquee.getByRole('link', { name: 'Cursor', exact: true }).click()
	await expect(page).toHaveURL(/\/with\/cursor$/)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Kody for Cursor' }),
	).toBeVisible()
})
