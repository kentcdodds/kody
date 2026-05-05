import { expect, test } from './playwright-utils.ts'

test('connect secret shows editable name and scope and saves the edited name', async ({
	page,
	login,
}) => {
	await login()

	const nonce = Date.now().toString(36)
	const queryName = `connect-secret-default-${nonce}`
	const editedName = `connect-secret-edited-${nonce}`
	const description = `Connect secret description ${nonce}`
	const secretValue = `secret-value-${nonce}`
	const packageId = `pkg-${nonce}`

	await page.goto(
		`/connect/secret?name=${encodeURIComponent(queryName)}&scope=user&description=${encodeURIComponent(description)}&allowedPackages=${encodeURIComponent(`${packageId}, ${packageId}`)}`,
	)

	await expect(page.getByLabel('Name')).toHaveValue(queryName)
	await expect(page.getByLabel('Scope')).toHaveValue('user')
	await expect(page.getByLabel('Description')).toHaveValue(description)
	await expect(page.getByPlaceholder('saved package id')).toHaveValue(packageId)

	await page.getByLabel('Name').fill(editedName)
	await page
		.locator('input[autocomplete="new-password"]')
		.first()
		.fill(secretValue)
	await page.getByRole('button', { name: 'Review' }).click()

	const reviewConfirmation = page.getByLabel(
		'I confirm these details are correct.',
	)
	await expect(reviewConfirmation).toBeVisible()
	await expect(page.getByText(packageId)).toBeVisible()
	await expect(page.getByRole('button', { name: 'Save secret' })).toBeDisabled()

	await reviewConfirmation.check()
	const saveResponse = page.waitForResponse(
		(response) =>
			response.url().endsWith('/connect/secret.json') &&
			response.request().method() === 'POST',
	)
	await page.getByRole('button', { name: 'Save secret' }).click()
	expect((await saveResponse).ok()).toBe(true)

	await page.goto(`/account/secrets/user/${editedName}`)
	await expect(
		page.getByRole('heading', { level: 2, name: editedName }),
	).toBeVisible()
	await expect(page.getByLabel('Description')).toHaveValue(description)
	const savedSecretInput = page
		.locator('input[autocomplete="new-password"]')
		.first()
	await expect(savedSecretInput).toHaveAttribute('type', 'password')
	await expect(savedSecretInput).toHaveValue(secretValue)
	await page.getByRole('button', { name: 'Show secret value' }).click()
	await expect(savedSecretInput).toHaveAttribute('type', 'text')
	await expect(savedSecretInput).toHaveValue(secretValue)
	await expect(page.getByPlaceholder('saved package id')).toHaveValue(packageId)
})
