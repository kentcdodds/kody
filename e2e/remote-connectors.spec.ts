import { expect, test } from './playwright-utils.ts'

test('remote connector persists after save and reload', async ({
	page,
	login,
}) => {
	await login()

	const nonce = Date.now().toString(36)
	const kind = `remote-${nonce}`
	const instanceId = `default-${nonce}`
	const sharedSecret = `shared-secret-${nonce}`

	await page.goto('/account/remote-connectors')
	await expect(
		page.getByRole('heading', { level: 1, name: /remote connectors/i }),
	).toBeVisible()

	await page.getByLabel('Kind').fill(kind)
	await page.getByLabel('Instance ID').fill(instanceId)
	const connectorUrl = page.getByText(
		new RegExp(`/@[^/]+/connectors/${kind}/${instanceId}$`),
	)
	await expect(connectorUrl).toBeVisible()
	await page.getByRole('textbox', { name: 'Shared secret' }).fill(sharedSecret)
	const saveResponse = page.waitForResponse(
		(response) =>
			response.url().endsWith('/account/remote-connectors.json') &&
			response.request().method() === 'POST',
	)
	await page.getByRole('button', { name: 'Save connector' }).click()
	expect((await saveResponse).ok()).toBe(true)

	await page.reload()
	await page
		.getByRole('button', { name: new RegExp(`${kind}:${instanceId}`) })
		.click()

	const sharedSecretInput = page.getByRole('textbox', {
		name: 'Shared secret',
	})
	await expect(connectorUrl).toBeVisible()
	await expect(sharedSecretInput).toHaveAttribute('type', 'password')
	await expect(sharedSecretInput).toHaveValue(sharedSecret)
})
