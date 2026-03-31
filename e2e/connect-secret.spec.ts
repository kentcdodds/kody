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

	await page.goto(
		`/connect/secret?name=${encodeURIComponent(queryName)}&scope=user&description=${encodeURIComponent(description)}`,
	)

	await expect(
		page.getByRole('heading', { level: 2, name: 'Enter secret' }),
	).toBeVisible()
	await expect(page.getByLabel('Name')).toHaveValue(queryName)
	await expect(page.getByLabel('Scope')).toHaveValue('user')
	await expect(page.getByLabel('Description')).toHaveValue(description)

	await page.getByLabel('Name').fill(editedName)
	await page.getByPlaceholder('Paste the secret value').fill(secretValue)
	await page.getByRole('button', { name: 'Review' }).click()

	const reviewCard = page
		.getByRole('heading', {
			level: 2,
			name: 'Review before saving',
		})
		.locator('xpath=ancestor::section[1]')

	await expect(
		page.getByRole('heading', { level: 2, name: 'Review before saving' }),
	).toBeVisible()
	await expect(reviewCard).toContainText('Secret name')
	await expect(reviewCard).toContainText(editedName)
	await expect(reviewCard).toContainText('Scope')
	await expect(reviewCard).toContainText('User')

	await page.getByLabel('I confirm these details are correct.').check()
	await page.getByRole('button', { name: 'Save secret' }).click()

	await expect(
		page.getByRole('heading', { level: 2, name: 'Secret saved' }),
	).toBeVisible()

	await page.goto(`/account/secrets/user/${editedName}`)
	await expect(
		page.getByRole('heading', { level: 2, name: editedName }),
	).toBeVisible()
	await expect(page.getByLabel('Description')).toHaveValue(description)
	await expect(
		page.getByPlaceholder('Enter the secret value').first(),
	).toHaveValue(secretValue)
})
