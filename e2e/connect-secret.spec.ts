import { expect, test } from './playwright-utils.ts'

test('connect secret saves edited metadata through the review flow', async ({
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
		`/connect/secret?name=${encodeURIComponent(queryName)}&scope=user&description=${encodeURIComponent(description)}&allowedPackages=${encodeURIComponent(packageId)}`,
	)

	await expect(page.getByLabel('Name')).toHaveValue(queryName)
	await expect(page.getByLabel('Scope')).toHaveValue('user')
	await expect(page.getByLabel('Description')).toHaveValue(description)

	const secretValueInput = page.getByRole('textbox', { name: /^Secret value/ })
	await page.getByLabel('Name').fill(editedName)
	await secretValueInput.fill(secretValue)
	await page.getByRole('button', { name: 'Review' }).click()

	const reviewConfirmation = page.getByLabel(
		'I confirm these details are correct.',
	)
	await expect(reviewConfirmation).toBeVisible()
	await expect(page.getByText(packageId)).toBeVisible()

	await reviewConfirmation.check()
	await page.getByRole('button', { name: 'Save secret' }).click()
	await expect(
		page.getByRole('heading', { level: 2, name: 'Secret saved' }),
	).toBeVisible()

	await page.goto(`/account/secrets/user/${editedName}`)
	await expect(
		page.getByRole('heading', { level: 2, name: editedName }),
	).toBeVisible()
	await expect(page.getByLabel('Description')).toHaveValue(description)
	const savedSecretInput = page.getByRole('textbox', { name: /^Secret value/ })
	await expect(savedSecretInput).toHaveAttribute('type', 'password')
	await expect(savedSecretInput).toHaveValue(secretValue)
})
