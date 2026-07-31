import { expect, test } from './playwright-utils.ts'

test('admin feature flags: global toggle and per-user override visibility', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const adminUser = await seedE2eUser({
		email: `ff-admin-${runId}@example.com`,
		username: `ff-admin-${runId}`,
		password: 'ff-admin-password',
		admin: true,
	})
	const memberUser = await seedE2eUser({
		email: `ff-member-${runId}@example.com`,
		username: `ff-member-${runId}`,
		password: 'ff-member-password',
	})

	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto('/')
	await expect(page.getByTestId('demo-indicator')).toHaveCount(0)

	await page.getByRole('link', { name: 'Admin', exact: true }).click()
	await page.getByRole('link', { name: 'Feature flags', exact: true }).click()
	await expect(page).toHaveURL(/\/admin\/feature-flags\/?$/)
	await expect(
		page.getByRole('heading', { name: 'Admin feature flags' }),
	).toBeVisible()

	// The permanent demo flag is intentionally unmeasured.
	await expect(
		page.getByTestId('success-metric-notice-demo-indicator'),
	).toContainText('No success metric declared')

	const demoFlagSection = page
		.getByRole('heading', { name: 'demo-indicator' })
		.locator('xpath=ancestor::section[1]')

	const enabledCheckbox = demoFlagSection.getByLabel('Enabled')
	if (await enabledCheckbox.isChecked()) {
		await enabledCheckbox.uncheck()
		await demoFlagSection
			.getByRole('button', { name: 'Save', exact: true })
			.click()
		await page.reload()
		await expect(page.getByTestId('demo-indicator')).toHaveCount(0)
	}

	await enabledCheckbox.check()
	await demoFlagSection.getByLabel('Note').fill(`e2e-global-${runId}`)
	await demoFlagSection
		.getByRole('button', { name: 'Save', exact: true })
		.click()
	await page.reload()
	await expect(page.getByTestId('demo-indicator')).toBeVisible()

	await enabledCheckbox.uncheck()
	await demoFlagSection
		.getByRole('button', { name: 'Save', exact: true })
		.click()
	await page.reload()
	await expect(page.getByTestId('demo-indicator')).toHaveCount(0)

	await demoFlagSection.getByLabel('Username').fill(memberUser.username)
	await demoFlagSection.getByLabel('State').selectOption('true')
	await demoFlagSection
		.getByRole('button', { name: 'Add override', exact: true })
		.click()

	const memberOverrideRow = demoFlagSection
		.locator('strong', { hasText: memberUser.username })
		.locator('xpath=../..')
	await expect(memberOverrideRow).toBeVisible()

	await page.reload()
	await expect(page.getByTestId('demo-indicator')).toHaveCount(0)

	await page.context().clearCookies()
	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	await page.goto('/')
	await expect(page.getByTestId('demo-indicator')).toBeVisible()

	await page.context().clearCookies()
	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto('/admin/feature-flags')
	await expect(memberOverrideRow).toBeVisible()
	await memberOverrideRow
		.getByRole('button', { name: 'Remove', exact: true })
		.click()
	await expect(memberOverrideRow).toHaveCount(0)

	await page.context().clearCookies()
	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	await page.goto('/')
	await expect(page.getByTestId('demo-indicator')).toHaveCount(0)
})
