import { expect, test } from './playwright-utils.ts'

test('admin feature flag lifecycle toggles the demo indicator', async ({
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

	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto('/')
	await expect(page.getByTestId('demo-indicator')).toHaveCount(0)

	await page.getByRole('link', { name: 'Admin', exact: true }).click()
	await expect(page).toHaveURL(/\/admin\/users\/?$/)
	await page.getByRole('link', { name: 'Feature flags', exact: true }).click()
	await expect(page).toHaveURL(/\/admin\/feature-flags\/?$/)
	await expect(
		page.getByRole('heading', { name: 'Admin feature flags' }),
	).toBeVisible()
	await expect(page.getByText('demo-indicator')).toBeVisible()

	const demoFlagSection = page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'demo-indicator' }) })

	// Shared e2e D1 may already have a global row from prior runs — start off.
	const enabledCheckbox = demoFlagSection.getByLabel('Enabled')
	if (await enabledCheckbox.isChecked()) {
		await enabledCheckbox.uncheck()
		await demoFlagSection
			.getByRole('button', { name: 'Save', exact: true })
			.click()
		await expect(
			page.getByText('Saved global state for demo-indicator.'),
		).toBeVisible()
		await page.reload()
		await expect(page.getByTestId('demo-indicator')).toHaveCount(0)
	}

	await expect(page.getByText(/default \(off\)|globally off/)).toBeVisible()

	await demoFlagSection.getByLabel('Enabled').check()
	await demoFlagSection.getByLabel('Note').fill(`e2e-global-${runId}`)
	await demoFlagSection
		.getByRole('button', { name: 'Save', exact: true })
		.click()
	await expect(
		page.getByText('Saved global state for demo-indicator.'),
	).toBeVisible()
	await expect(page.getByText('globally on')).toBeVisible()
	await expect(page.getByText('Last updated')).toBeVisible()
	await expect(page.getByText('Updated by')).toBeVisible()
	await expect(page.getByText(`e2e-global-${runId}`)).toBeVisible()

	await page.reload()
	await expect(page.getByTestId('demo-indicator')).toBeVisible()

	await demoFlagSection.getByLabel('Enabled').uncheck()
	await demoFlagSection
		.getByRole('button', { name: 'Save', exact: true })
		.click()
	await expect(
		page.getByText('Saved global state for demo-indicator.'),
	).toBeVisible()
	await expect(page.getByText('globally off')).toBeVisible()

	await page.reload()
	await expect(page.getByTestId('demo-indicator')).toHaveCount(0)
})

test('feature flag admin access and per-user overrides', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const adminUser = await seedE2eUser({
		email: `ff-access-admin-${runId}@example.com`,
		username: `ff-access-admin-${runId}`,
		password: 'ff-access-admin-password',
		admin: true,
	})
	const memberUser = await seedE2eUser({
		email: `ff-access-member-${runId}@example.com`,
		username: `ff-access-member-${runId}`,
		password: 'ff-access-member-password',
	})

	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	await page.goto('/admin/feature-flags')
	await expect(
		page.getByRole('heading', { name: 'Admin feature flags' }),
	).toBeHidden()
	await expect(page.getByText('Forbidden')).toBeVisible()
	await expect(
		page.getByRole('link', { name: 'Admin', exact: true }),
	).toHaveCount(0)
	await expect(page.getByTestId('demo-indicator')).toHaveCount(0)

	await page.context().clearCookies()
	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto('/admin/feature-flags')
	await expect(
		page.getByRole('heading', { name: 'Admin feature flags' }),
	).toBeVisible()

	const demoFlagSection = page
		.locator('section')
		.filter({ has: page.getByRole('heading', { name: 'demo-indicator' }) })

	// Keep the flag globally off so only the member override enables it.
	const enabledCheckbox = demoFlagSection.getByLabel('Enabled')
	if (await enabledCheckbox.isChecked()) {
		await enabledCheckbox.uncheck()
		await demoFlagSection
			.getByRole('button', { name: 'Save', exact: true })
			.click()
		await expect(
			page.getByText('Saved global state for demo-indicator.'),
		).toBeVisible()
	}

	await demoFlagSection.getByLabel('Username').fill(memberUser.username)
	await demoFlagSection.getByLabel('State').selectOption('true')
	await demoFlagSection
		.getByRole('button', { name: 'Add override', exact: true })
		.click()
	await expect(
		page.getByText(
			`Saved override for ${memberUser.username} on demo-indicator.`,
		),
	).toBeVisible()

	const memberOverrideRow = demoFlagSection
		.locator('strong', { hasText: memberUser.username })
		.locator('xpath=../..')
	await expect(memberOverrideRow.getByText(/Forced on/)).toBeVisible()

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
	await expect(
		page.getByRole('heading', { name: 'Admin feature flags' }),
	).toBeVisible()
	await memberOverrideRow
		.getByRole('button', { name: 'Remove', exact: true })
		.click()
	await expect(
		page.getByText(`Removed override for ${memberUser.username}.`),
	).toBeVisible()

	await page.context().clearCookies()
	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	await page.goto('/')
	await expect(page.getByTestId('demo-indicator')).toHaveCount(0)
})
