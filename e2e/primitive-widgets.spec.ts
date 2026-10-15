import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('primitive widgets animate in view, answer clicks, and hold still for reduced motion', async ({
	page,
}) => {
	await page.goto('/')
	await waitForClientHydration(page)
	const cards = page.locator('.landing-pcards')
	await cards.scrollIntoViewIfNeeded()
	await expect(cards.getByRole('link')).toHaveCount(6)
	const memoryCard = cards.getByRole('link', { name: /Memory/ })
	await expect(memoryCard).toHaveAttribute('href', '/features/memory')
	await expect(memoryCard.locator('.pw')).toHaveAttribute('data-motion', '')

	await page.goto('/features')
	await waitForClientHydration(page)
	const triggers = page.getByRole('group', { name: 'Triggers example' })
	await triggers.scrollIntoViewIfNeeded()
	await expect(triggers.locator('.pw')).toHaveAttribute('data-motion', '')
	const webhook = triggers.getByRole('button', { name: 'Fire webhook trigger' })
	await expect(webhook).toHaveAttribute('aria-pressed', 'false')
	await webhook.click()
	await expect(webhook).toHaveAttribute('aria-pressed', 'true')
	await expect(triggers.locator('.receipt')).toBeVisible()
	await expect(page).toHaveURL(/\/features$/)

	const integrations = page.getByRole('group', { name: 'Credentials example' })
	await integrations.getByRole('button', { name: 'Book Wed 2:30' }).click()
	await expect(integrations.locator('.pw-cal-open[data-on]')).toHaveCount(1)

	const packages = page.getByRole('group', { name: 'Packages example' })
	await packages.getByRole('button', { name: 'Invoke from Cursor' }).click()
	await expect(
		packages.getByRole('button', { name: 'Invoke from Cursor' }),
	).toHaveAttribute('aria-pressed', 'true')

	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.reload()
	await waitForClientHydration(page)
	const apps = page.getByRole('group', { name: 'Apps example' })
	await apps.scrollIntoViewIfNeeded()
	await apps.getByRole('button', { name: 'Reading list' }).click()
	await expect(apps.locator('.pw-app-title')).toHaveText('Reading list')
	await expect(apps.locator('.pw')).not.toHaveAttribute('data-motion')
	await expect(apps.locator('.pw-toast')).toBeVisible()
})
