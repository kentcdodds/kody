import { expect, test } from './playwright-utils.ts'

test('admin RBAC controls access, role assignment, and privacy boundaries', async ({
	page,
	seedE2eUser,
	assignRole,
	login,
}) => {
	const runId = Date.now()
	const adminUser = await seedE2eUser({
		email: `admin-rbac-${runId}@example.com`,
		username: `admin-rbac-${runId}`,
		password: 'admin-rbac-password',
	})
	const memberUser = await seedE2eUser({
		email: `member-rbac-${runId}@example.com`,
		username: `member-rbac-${runId}`,
		password: 'member-rbac-password',
	})

	await assignRole(adminUser.email, 'admin')

	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	await page.goto('/admin/users')
	await expect(page.getByRole('heading', { name: 'Admin users' })).toBeHidden()
	await expect(page.getByText('Forbidden')).toBeVisible()
	const memberUsageResponse = await page.request.get(
		'/admin/users/usage.json?stableUserId=forbidden',
	)
	expect(memberUsageResponse.status()).toBe(403)
	await page.goto('/admin/insights')
	await expect(
		page.getByRole('heading', { name: 'Admin insights' }),
	).toBeHidden()
	await expect(page.getByText('Forbidden')).toBeVisible()
	await expect(
		page.getByRole('link', { name: 'Admin', exact: true }),
	).toHaveCount(0)

	const secretResponse = await page.request.post('/account/secrets.json', {
		data: {
			action: 'save',
			name: 'memberPrivateSecret',
			scope: 'user',
			value: 'super-secret-value',
			description: 'Seeded for admin privacy test',
			allowedHosts: ['api.example.com'],
			allowedCapabilities: [],
			allowedPackages: [],
		},
		headers: { 'Content-Type': 'application/json' },
	})
	expect(secretResponse.ok()).toBe(true)

	await page.context().clearCookies()
	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto('/')

	await expect(
		page.getByRole('link', { name: 'Admin', exact: true }),
	).toBeVisible()
	await page.getByRole('link', { name: 'Admin', exact: true }).click()
	await expect(page).toHaveURL(/\/admin\/users\/?$/)
	await expect(page.getByRole('heading', { name: 'Admin users' })).toBeVisible()

	await page.goto(`/admin/users?q=rbac-${runId}`)
	await expect(
		page.getByRole('button', { name: memberUser.username }),
	).toBeVisible()
	await expect(page.getByText(memberUser.email)).toBeVisible()
	await expect(page.getByText('memberPrivateSecret')).toHaveCount(0)
	await expect(page.getByText('super-secret-value')).toHaveCount(0)

	const usersApiResponse = await page.request.get(
		`/admin/users.json?q=rbac-${runId}`,
	)
	expect(usersApiResponse.ok()).toBe(true)
	const usersPayload = await usersApiResponse.json()
	expect(usersPayload.ok).toBe(true)
	const memberRecord = usersPayload.users.find(
		(user: { email: string }) => user.email === memberUser.email,
	)
	expect(memberRecord).toBeTruthy()
	expect(JSON.stringify(memberRecord)).not.toContain('memberPrivateSecret')
	expect(JSON.stringify(memberRecord)).not.toContain('super-secret-value')

	await page.getByRole('button', { name: memberUser.username }).click()
	await expect(page.getByText('Account metadata only')).toBeVisible()
	await expect(page.getByText('memberPrivateSecret')).toHaveCount(0)
	await expect(page.getByText('super-secret-value')).toHaveCount(0)

	await page.goto(`/admin/users?q=rbac-${runId}`)
	await page.getByRole('button', { name: memberUser.username }).click()
	const roleSelect = page.getByLabel('Role', { exact: true })
	await roleSelect.selectOption('admin')
	await page.getByRole('button', { name: 'Assign', exact: true }).click()

	await page.context().clearCookies()
	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	const sessionResponse = await page.request.get('/session')
	expect(sessionResponse.ok()).toBe(true)
	const sessionPayload = await sessionResponse.json()
	expect(sessionPayload.session.roles).toContain('admin')
})
