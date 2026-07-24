import { expect, test } from './playwright-utils.ts'

test('remote connectors use URL-backed list/detail selection', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `remote-connectors-${runId}@example.com`,
		username: `remote-connectors-${runId}`,
		password: 'remote-connectors-password',
	})
	await login({
		email: user.email,
		password: user.password,
		mode: 'login',
	})

	await page.goto('/account/remote-connectors')
	await expect(
		page.getByRole('heading', { name: 'Remote connectors' }),
	).toBeVisible()

	await page.getByRole('button', { name: 'New connector' }).click()
	await expect(page).toHaveURL(/\/account\/remote-connectors\/new$/)
	await expect(
		page.getByRole('heading', { name: 'New remote connector' }),
	).toBeVisible()

	const instanceId = `home-${runId}`
	await page.getByLabel('Connector name').fill(instanceId)
	await page.getByRole('button', { name: 'Generate' }).click()
	await page.getByRole('button', { name: 'Save connector' }).click()

	await expect(page).toHaveURL(/\/account\/remote-connectors\/[0-9a-f-]{36}$/i)
	await expect(page.getByRole('heading', { name: instanceId })).toBeVisible()

	const detailUrl = page.url()
	await page.reload()
	await expect(page).toHaveURL(detailUrl)
	await expect(page.getByRole('heading', { name: instanceId })).toBeVisible()
	await expect(page.getByLabel('Connector name')).toHaveValue(instanceId)

	await page.getByLabel('Search', { exact: true }).fill(instanceId)
	await expect(page).toHaveURL(new RegExp(`q=${instanceId}`))
	await expect(page.getByRole('button', { name: instanceId })).toBeVisible()
})
