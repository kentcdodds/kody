import { expect, test } from '@playwright/test'

test('calculator widget buttons respond in default iframe', async ({
	page,
}) => {
	await page.goto('/dev/calculator-widget-test')
	await expect(
		page.getByRole('heading', { name: 'Calculator Widget Test' }),
	).toBeVisible()

	const iframe = page.frameLocator('#calc-default')
	await expect(
		iframe.getByRole('heading', { name: 'Calculator' }),
	).toBeVisible()

	const resultEl = iframe.locator('[data-result]')
	await expect(resultEl).toHaveText('0')

	await iframe.getByRole('button', { name: '7' }).click()
	await iframe.getByRole('button', { name: '+' }).click()
	await iframe.getByRole('button', { name: '3' }).click()
	await iframe.getByRole('button', { name: '=' }).click()
	await expect(resultEl).toHaveText('10')
})

test('calculator widget buttons respond in sandboxed iframe', async ({
	page,
}) => {
	await page.goto('/dev/calculator-widget-test')
	const sandboxedIframe = page.frameLocator('#calc-sandboxed')
	await expect(
		sandboxedIframe.getByRole('heading', { name: 'Calculator' }),
	).toBeVisible()

	const resultEl = sandboxedIframe.locator('[data-result]')
	await expect(resultEl).toHaveText('0')

	await sandboxedIframe.getByRole('button', { name: '7' }).click()
	await sandboxedIframe.getByRole('button', { name: '+' }).click()
	await sandboxedIframe.getByRole('button', { name: '3' }).click()
	await sandboxedIframe.getByRole('button', { name: '=' }).click()
	await expect(resultEl).toHaveText('10')
})

test('sandboxed calculator sends result back to host chat on =', async ({
	page,
}) => {
	await page.goto('/dev/calculator-widget-test')
	const sandboxedIframe = page.frameLocator('#calc-sandboxed')
	await expect(
		sandboxedIframe.getByRole('heading', { name: 'Calculator' }),
	).toBeVisible()

	await sandboxedIframe.getByRole('button', { name: '7' }).click()
	await sandboxedIframe.getByRole('button', { name: '+' }).click()
	await sandboxedIframe.getByRole('button', { name: '3' }).click()
	await sandboxedIframe.getByRole('button', { name: '=' }).click()

	await expect(
		page.locator('[data-host-chat="calc-sandboxed"] [data-chat-message]'),
	).toContainText('Calculator result: 7 + 3 = 10')
})
