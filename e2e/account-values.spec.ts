import { expect, test } from './playwright-utils.ts'

test('account values use URL-backed list/detail selection', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `account-values-${runId}@example.com`,
		username: `account-values-${runId}`,
		password: 'account-values-password',
	})
	await login({
		email: user.email,
		password: user.password,
		mode: 'login',
	})

	await page.goto('/account/values')
	await expect(
		page.getByRole('heading', { name: 'Values', exact: true }),
	).toBeVisible()

	await page.getByRole('button', { name: 'New value' }).click()
	await expect(page).toHaveURL(/\/account\/values\/new$/)
	await expect(
		page.getByRole('heading', { name: 'New value', exact: true }),
	).toBeVisible()

	const valueName = `preferred-locale-${runId}`
	const valueBody = `en-US-${runId}`
	await page.getByLabel('Name', { exact: true }).fill(valueName)
	await page.getByLabel('Description').fill('Preferred locale')
	await page.getByLabel('Value', { exact: true }).fill(valueBody)
	await page.getByRole('button', { name: 'Create value' }).click()

	await expect(page).toHaveURL(
		new RegExp(`/account/values/${encodeURIComponent(valueName)}$`),
	)
	await expect(
		page.getByRole('heading', { name: valueName, exact: true }),
	).toBeVisible()

	const detailUrl = page.url()
	await page.reload()
	await expect(page).toHaveURL(detailUrl)
	await expect(
		page.getByRole('heading', { name: valueName, exact: true }),
	).toBeVisible()
	await expect(page.getByLabel('Name', { exact: true })).toHaveValue(valueName)
	await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute(
		'readonly',
		'',
	)
	await expect(page.getByLabel('Value', { exact: true })).toHaveValue(valueBody)

	await page.getByLabel('Search', { exact: true }).fill(valueName)
	await expect(page).toHaveURL(new RegExp(`q=${valueName}`))
	await expect(page.getByRole('button', { name: valueName })).toBeVisible()
})
