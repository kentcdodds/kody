import { expect, test, waitForClientHydration } from './playwright-utils.ts'

const featurePages = [
	'memory',
	'secrets',
	'packages',
	'triggers',
	'integrations',
	'apps',
] as const

test('feature page scenes animate in view and hold still for reduced motion', async ({
	page,
}) => {
	for (const feature of featurePages) {
		await page.goto(`/features/${feature}`)
		await waitForClientHydration(page)
		const scenes = page.locator('.pw')
		const count = await scenes.count()
		expect(count, `${feature} scenes`).toBeGreaterThan(1)
		for (let i = 0; i < count; i++) {
			const scene = scenes.nth(i)
			await scene.scrollIntoViewIfNeeded()
			await expect(scene, `${feature} scene ${i}`).toHaveAttribute(
				'data-motion',
				'',
			)
		}
	}

	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.goto('/features/memory')
	await waitForClientHydration(page)
	const hero = page.locator('.pw').first()
	await expect(hero).toBeVisible()
	await expect(hero).not.toHaveAttribute('data-motion')
	await page.getByRole('button', { name: 'Save in one agent' }).click()
	await expect(hero.locator('#memory-result')).toHaveText(
		'Saved your writing preference in Kody.',
	)
})

test('memory scenes follow the page controls', async ({ page }) => {
	await page.goto('/features/memory')
	await waitForClientHydration(page)

	await page.getByRole('button', { name: 'People' }).click()
	await expect(page.locator('#ms-task')).toHaveText(
		'Draft a question for my accountant.',
	)
	await expect(page.locator('.pw-mem-row[data-on]')).toContainText(
		'Morgan is my accountant.',
	)

	await page.getByRole('button', { name: 'Make updates more detailed' }).click()
	await expect(page.locator('#ms-updated-note')).toHaveText(
		'Include the decision, the reason, and the next step.',
	)
	await expect(page.locator('#ms-hero-note')).toHaveText(
		'Include the decision, the reason, and the next step.',
	)
	await page.getByRole('button', { name: 'Reset example' }).click()
	await expect(page.locator('#ms-updated-note')).toHaveText(
		'Lead with the decision. Keep updates short.',
	)
})
