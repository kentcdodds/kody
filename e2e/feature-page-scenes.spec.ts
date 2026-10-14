import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('feature page scenes animate in view and hold still for reduced motion', async ({
	page,
}) => {
	await page.goto('/features/memory')
	await waitForClientHydration(page)
	const hero = page.locator('.pw').first()
	await expect(hero).toHaveAttribute('data-motion', '')

	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.goto('/features/memory')
	await waitForClientHydration(page)
	await expect(hero).toBeVisible()
	await expect(hero).not.toHaveAttribute('data-motion')
	await page.getByRole('button', { name: 'Save in one agent' }).click()
	await expect(hero.locator('#memory-result')).toHaveText(/Saved/)
})
