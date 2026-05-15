import { expect, test } from './playwright-utils.ts'

test('account new secret form saves query-prefilled metadata', async ({
	page,
	login,
}) => {
	await login()

	const nonce = Date.now().toString(36)
	const queryName = `account-secret-default-${nonce}`
	const editedName = `account-secret-edited-${nonce}`
	const description = `Account secret description ${nonce}`
	const secretValue = `secret-value-${nonce}`
	const packageId = `pkg-${nonce}`

	await page.goto(
		`/account/secrets/new?name=${encodeURIComponent(queryName)}&scope=user&description=${encodeURIComponent(description)}&allowedHosts=API.LINEAR.APP&allowedCapabilities=linear_issue_list&allowedPackages=${encodeURIComponent(packageId)}`,
	)

	await expect(page.getByLabel('Name')).toHaveValue(queryName)
	await expect(page.getByLabel('Scope')).toHaveValue('user')
	await expect(page.getByLabel('Description')).toHaveValue(description)
	await expect(page.getByPlaceholder('api.example.com')).toHaveValue(
		'api.linear.app',
	)
	await expect(
		page.getByPlaceholder('home_lutron_set_credentials'),
	).toHaveValue('linear_issue_list')
	await expect(page.getByPlaceholder('saved package id')).toHaveValue(packageId)

	await page.getByLabel('Name').fill(editedName)
	await page.getByRole('textbox', { name: /^Secret value/ }).fill(secretValue)
	await page.getByRole('button', { name: 'Save' }).click()

	await expect(page).toHaveURL(
		new RegExp(`/account/secrets/user/${editedName}$`),
	)
	await expect(
		page.getByRole('heading', { level: 2, name: editedName }),
	).toBeVisible()
	await expect(page.getByLabel('Description')).toHaveValue(description)
	const savedSecretInput = page.getByRole('textbox', { name: /^Secret value/ })
	await expect(savedSecretInput).toHaveAttribute('type', 'password')
	await expect(savedSecretInput).toHaveValue(secretValue)
	await expect(page.getByPlaceholder('saved package id')).toHaveValue(packageId)
})
