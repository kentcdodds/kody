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

test('secrets scene withholds the key from an unapproved host', async ({
	page,
}) => {
	await page.goto('/features/secrets')
	await waitForClientHydration(page)
	await page.getByRole('button', { name: 'Unapproved host' }).click()
	await page.getByRole('button', { name: 'Send example request' }).click()
	await expect(page.locator('#secret-result')).toHaveText(
		'Blocked. This host is not approved.',
	)
	await expect(page.locator('.pw-scene-sec-trip .pw-run')).toHaveAttribute(
		'data-blocked',
		'',
	)
	await expect(page.locator('.pw-scene-sec-trip .pw-sec-lane-key')).toHaveCount(
		0,
	)
})

test('packages scene publishes the previewed change', async ({ page }) => {
	await page.goto('/features/packages')
	await waitForClientHydration(page)
	const publish = page.getByRole('button', { name: 'Publish example change' })
	await expect(publish).toBeDisabled()
	await page.getByLabel('Include open questions').check()
	await page.getByRole('button', { name: 'Preview proposed change' }).click()
	await publish.click()
	await expect(page.locator('.pw-scene-pkg-publish')).toContainText('v2')
	await expect(page.locator('.pw-scene-pkg-publish')).toContainText(
		'Open question: Who approves the final copy?',
	)
})

test('triggers scan result follows the flaky-test toggle', async ({ page }) => {
	await page.goto('/features/triggers')
	await waitForClientHydration(page)
	const result = page.locator('#pt-scan-result')
	await page.getByRole('button', { name: 'Run example scan' }).click()
	await expect(result).toHaveText(
		'Scan complete. No flakes found, no agent called, no notification.',
	)
	await page.getByLabel('Include a flaky test in this example').check()
	await expect(result).toHaveText('A clean scan can end with no notification.')
	await page.getByRole('button', { name: 'Run example scan' }).click()
	await expect(result).toHaveText(
		'Flake found. The example package calls an agent to investigate.',
	)
})

test('integrations scene routes the saved connection to the chosen package', async ({
	page,
}) => {
	await page.goto('/features/integrations')
	await waitForClientHydration(page)
	const pick = page.getByRole('button', { name: 'meeting-prep' })
	await pick.click()
	await expect(pick).toHaveAttribute('aria-pressed', 'true')
	await expect(page.locator('#ia-output-title')).toHaveText('Walk in prepared.')
})

test('apps share scene lights the steps for the chosen access', async ({
	page,
}) => {
	await page.goto('/features/apps')
	await waitForClientHydration(page)
	await page.getByLabel('Morgan’s access').selectOption('Manage')
	const run = page.locator('.pw-run[data-role="Manage"]')
	await expect(run).toBeVisible()
	await expect(run.locator('.pw-apx-step[data-on]')).toHaveCount(3)
})
