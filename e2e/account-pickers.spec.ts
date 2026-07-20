import { expect, test } from './playwright-utils.ts'
import {
	seedIntegrationInE2eDatabase,
	seedSavedPackageInE2eDatabase,
} from './d1-utils.ts'

test('account package picker and integration search use recognizable names', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `account-pickers-${runId}@example.com`,
		username: `account-pickers-${runId}`,
		password: 'account-pickers-password',
	})
	const calendarPackage = {
		packageId: `50cfcf4d-83a0-48f0-b713-${String(runId).slice(-12)}`,
		kodyId: `calendar-assistant-${runId}`,
		name: `@account-pickers/calendar-${runId}`,
	}
	const tasksPackage = {
		packageId: `8b3f33e5-353a-47b9-868e-${String(runId + 1).slice(-12)}`,
		kodyId: `task-assistant-${runId}`,
		name: `@account-pickers/tasks-${runId}`,
	}

	await seedSavedPackageInE2eDatabase({
		ownerEmail: user.email,
		...calendarPackage,
	})
	await seedSavedPackageInE2eDatabase({
		ownerEmail: user.email,
		...tasksPackage,
	})
	await seedIntegrationInE2eDatabase({
		ownerEmail: user.email,
		name: `github-${runId}`,
		tokenUrl: 'https://github.com/login/oauth/access_token',
		apiBaseUrl: 'https://api.github.com',
		requiredHosts: ['api.github.com'],
		scopes: ['repo', 'read:user'],
	})
	await seedIntegrationInE2eDatabase({
		ownerEmail: user.email,
		name: `spotify-${runId}`,
		tokenUrl: 'https://accounts.spotify.com/api/token',
		apiBaseUrl: 'https://api.spotify.com/v1',
		requiredHosts: ['api.spotify.com'],
		scopes: ['user-read-playback-state'],
	})
	await login({ ...user, mode: 'login' })

	const secretName = `pickerSecret${runId}`
	const createSecretResponse = await page.request.post(
		'/account/secrets.json',
		{
			data: {
				action: 'save',
				currentId: null,
				name: secretName,
				scope: 'user',
				packageId: null,
				description: 'Secret used to exercise package access pickers.',
				value: 'local-e2e-secret-value',
				allowedHosts: [],
				allowedCapabilities: [],
				allowedPackages: [],
			},
		},
	)
	expect(createSecretResponse.ok()).toBe(true)

	await page.goto(
		`/account/secrets/user/${secretName}?package_id=${calendarPackage.packageId}&package=${calendarPackage.kodyId}`,
	)
	await expect(
		page.getByRole('heading', { name: 'Approve secret access' }),
	).toBeVisible()
	const approvalCard = page
		.getByRole('heading', { name: 'Approve secret access' })
		.locator('..')
	await expect(
		approvalCard.getByText(calendarPackage.kodyId, { exact: true }),
	).toBeVisible()
	await expect(
		approvalCard.getByText(calendarPackage.packageId, { exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Approve', exact: true }).click()
	await expect(
		page.getByRole('button', {
			name: `Remove package ${calendarPackage.kodyId}`,
		}),
	).toBeVisible()

	const allowedPackagePicker = page.getByLabel('Add allowed package')
	await allowedPackagePicker.fill(tasksPackage.kodyId)
	await allowedPackagePicker.press('ArrowDown')
	await allowedPackagePicker.press('Enter')
	const selectedPackageRow = page
		.getByRole('button', {
			name: `Remove package ${tasksPackage.kodyId}`,
		})
		.locator('..')
	await expect(
		selectedPackageRow.getByText(tasksPackage.kodyId, { exact: true }),
	).toBeVisible()
	await expect(
		selectedPackageRow.getByText(tasksPackage.packageId, { exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Save', exact: true }).click()
	await expect(page.getByText('Saved secret.')).toBeVisible()

	await page.goto('/account/integrations')
	const integrationSearch = page.getByLabel('Search integrations')
	await expect(integrationSearch).toBeVisible()
	await integrationSearch.fill('spotify playback')
	await expect(
		page.getByRole('heading', { name: `spotify-${runId}`, exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: `github-${runId}`, exact: true }),
	).not.toBeVisible()
	await expect(page.getByText('1 of 2 integrations')).toBeVisible()
})
