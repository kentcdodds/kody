import { expect, test } from './playwright-utils.ts'

test('remote connector form reloads, reveals, and generates shared secrets', async ({
	context,
	page,
	login,
}) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write'])
	await login()

	const nonce = Date.now().toString(36)
	const kind = `remote-${nonce}`
	const instanceId = `default-${nonce}`
	const sharedSecret = `shared-secret-${nonce}`

	await page.goto('/account/remote-connectors')
	await expect(
		page.getByRole('heading', { level: 1, name: /remote connectors/i }),
	).toBeVisible()
	await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible()
	await expect(
		page.getByRole('button', { name: /copy connector url/i }),
	).toHaveCount(0)

	await page.getByLabel('Kind').fill(kind)
	await page.getByLabel('Instance ID').fill(instanceId)
	const connectorUrl = page
		.locator('code')
		.filter({ hasText: '/connectors/u/' })
	await expect(connectorUrl).toHaveText(
		new RegExp(`/connectors/u/[^/]+/${kind}/${instanceId}$`),
	)
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
	await expect(sharedSecretInput).toHaveAttribute('type', 'password')
	await expect(sharedSecretInput).toHaveValue(sharedSecret)
	await expect(
		page.getByRole('button', { name: /copy connector url/i }),
	).toBeVisible()
	await page.getByRole('button', { name: /copy connector url/i }).click()
	await expect(
		page.getByRole('button', { name: /copied connector url/i }),
	).toBeVisible()
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toMatch(new RegExp(`/connectors/u/[^/]+/${kind}/${instanceId}$`))

	await page.getByRole('button', { name: 'Show shared secret' }).click()
	await expect(sharedSecretInput).toHaveAttribute('type', 'text')
	await expect(sharedSecretInput).toHaveValue(sharedSecret)

	await page.getByRole('button', { name: 'Generate' }).click()
	await expect(sharedSecretInput).not.toHaveValue(sharedSecret)
	await expect(sharedSecretInput).toHaveAttribute('type', 'text')
})
