import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('primitive widgets animate in view, answer clicks, and hold still for reduced motion', async ({
	page,
}) => {
	await page.goto('/')
	await waitForClientHydration(page)
	const cards = page.locator('.landing-pcards')
	await cards.scrollIntoViewIfNeeded()
	await expect(cards.getByRole('link')).toHaveCount(7)
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
	await expect(triggers.locator('.receipt')).toHaveText(
		'Webhook woke purchase-thanks. Run 13 finished without a chat open.',
	)
	await expect(page).toHaveURL(/\/features$/)

	const integrations = page.getByRole('group', { name: 'Integrations example' })
	await integrations.getByRole('button', { name: 'Book Wed 2:30' }).click()
	await expect(integrations.locator('.receipt')).toHaveText(
		'Booked Wed 2:30 on google-work. The request went out through Kody and the confirmation came back.',
	)
	await expect(integrations.locator('.pw-cal-open[data-on]')).toHaveCount(1)

	const packages = page.getByRole('group', { name: 'Packages example' })
	await packages.getByRole('button', { name: 'Invoke from Cursor' }).click()
	await expect(
		packages.getByRole('button', { name: 'Invoke from Cursor' }),
	).toHaveAttribute('aria-pressed', 'true')
	await expect(packages.locator('.receipt')).toHaveText(
		"Cursor invoked weekly-brief v1.2 and got this week's brief back.",
	)

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
