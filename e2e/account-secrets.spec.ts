import { expect, test } from './playwright-utils.ts'

async function saveSecret(
	page: Parameters<Parameters<typeof test>[1]>[0]['page'],
	input: {
		name: string
		description: string
		value: string
	},
) {
	const response = await page.request.post('/account/secrets.json', {
		data: {
			action: 'save',
			name: input.name,
			scope: 'user',
			appId: null,
			description: input.description,
			value: input.value,
			allowedHosts: [],
			allowedCapabilities: [],
		},
		headers: { 'Content-Type': 'application/json' },
	})
	expect(response.ok()).toBeTruthy()
}

test('switching secrets updates detail view without a full reload', async ({
	page,
	login,
}) => {
	await login()

	const nonce = Date.now().toString(36)
	const firstSecret = {
		name: `secret-switch-a-${nonce}`,
		description: `First router test secret ${nonce}`,
		value: `value-a-${nonce}`,
	}
	const secondSecret = {
		name: `secret-switch-b-${nonce}`,
		description: `Second router test secret ${nonce}`,
		value: `value-b-${nonce}`,
	}

	await saveSecret(page, firstSecret)
	await saveSecret(page, secondSecret)

	await page.goto(`/account/secrets/user/${firstSecret.name}`)
	await expect(
		page.getByRole('heading', { level: 2, name: firstSecret.name }),
	).toBeVisible()
	await expect(page.getByLabel('Description')).toHaveValue(
		firstSecret.description,
	)

	await page.evaluate(() => {
		;(
			window as typeof window & { __secretRouteMarker?: string }
		).__secretRouteMarker = 'still-here'
	})

	await page.getByRole('button', { name: secondSecret.name }).click()

	await expect(page).toHaveURL(
		new RegExp(`/account/secrets/user/${secondSecret.name}$`),
	)
	await expect(
		page.getByRole('heading', { level: 2, name: secondSecret.name }),
	).toBeVisible()
	await expect(page.getByLabel('Description')).toHaveValue(
		secondSecret.description,
	)
	await expect(
		page.getByPlaceholder('Enter the secret value').first(),
	).toHaveValue(secondSecret.value)
	await expect(
		page.evaluate(
			() =>
				(window as typeof window & { __secretRouteMarker?: string })
					.__secretRouteMarker,
		),
	).resolves.toBe('still-here')
})
