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

	const editorForm = page.locator('form').filter({
		has: page.getByRole('heading', { name: 'New secret' }),
	})
	await expect(editorForm.getByLabel('Name')).toHaveValue(queryName)
	await expect(editorForm.getByLabel('Scope')).toHaveValue('user')
	await expect(editorForm.getByLabel('Description')).toHaveValue(description)
	await expect(page.getByPlaceholder('api.example.com')).toHaveValue(
		'api.linear.app',
	)
	await expect(
		page.getByPlaceholder('home_lutron_set_credentials'),
	).toHaveValue('linear_issue_list')
	await expect(page.getByPlaceholder('saved package id')).toHaveValue(packageId)

	await editorForm.getByLabel('Name').fill(editedName)
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

	await page.goto(`/account/secrets/user/${editedName}?capability=secret_set`)
	await expect(
		page.getByRole('heading', { level: 2, name: editedName }),
	).toBeVisible()
	const capabilityInputs = page.getByPlaceholder('home_lutron_set_credentials')
	await expect(capabilityInputs).toHaveCount(2)
	await expect(capabilityInputs.nth(0)).toHaveValue('linear_issue_list')
	await expect(capabilityInputs.nth(1)).toHaveValue('secret_set')
})
