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
	await page.goto('/')
	await page.goto('/admin/users')
	await expect(page.getByRole('heading', { name: 'Admin users' })).toBeHidden()
	await expect(page.getByText('Forbidden')).toBeVisible()
	await page.goto('/admin/usage')
	await expect(page.getByRole('heading', { name: 'Admin usage' })).toBeHidden()
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

	await page.evaluate(() => {
		;(window as Window & { __e2eMarker?: boolean }).__e2eMarker = true
	})
	await page.getByRole('link', { name: 'Admin', exact: true }).click()
	await expect(page).toHaveURL(/\/admin\/users\/?$/)
	await expect(page.getByRole('heading', { name: 'Admin users' })).toBeVisible()
	await expect(page.getByText('Unable to load admin users.')).toHaveCount(0)
	// The detail panel must render the auto-selected user after SPA
	// navigation (regression: preloaded loader data consumed mid-render left
	// derivations from pre-navigation state on screen).
	await expect(page.getByText('Account metadata only')).toBeVisible()
	expect(
		await page.evaluate(
			() => (window as Window & { __e2eMarker?: boolean }).__e2eMarker,
		),
	).toBe(true)

	const initialUsersApiResponse = await page.request.get(
		'/admin/users.json?pageSize=100',
	)
	expect(initialUsersApiResponse.ok()).toBe(true)
	const initialUsersPayload = await initialUsersApiResponse.json()
	expect(initialUsersPayload.ok).toBe(true)
	const lastUsersPage = Math.max(
		1,
		Math.ceil(Number(initialUsersPayload.total) / 100),
	)

	await page.goto(`/admin/users?pageSize=100&page=${lastUsersPage}`)
	await expect(page.getByRole('heading', { name: 'Admin users' })).toBeVisible()
	// The first user is auto-selected, so the email can render in both the
	// list and the detail panel — assert on the list entry specifically.
	await expect(
		page.getByRole('button', { name: adminUser.username }),
	).toBeVisible()
	await expect(page.getByText(memberUser.email)).toBeVisible()
	await expect(page.getByText('memberPrivateSecret')).toHaveCount(0)
	await expect(page.getByText('super-secret-value')).toHaveCount(0)

	const usersApiResponse = await page.request.get(
		`/admin/users.json?pageSize=100&page=${lastUsersPage}`,
	)
	expect(usersApiResponse.ok()).toBe(true)
	const usersPayload = await usersApiResponse.json()
	expect(usersPayload.ok).toBe(true)
	const memberRecord = usersPayload.users.find(
		(user: { email: string }) => user.email === memberUser.email,
	)
	expect(memberRecord).toBeTruthy()
	expect(Object.keys(memberRecord).sort()).toEqual(
		[
			'created_at',
			'email',
			'email_verified',
			'email_verified_at',
			'id',
			'roles',
			'updated_at',
			'username',
		].sort(),
	)
	expect(JSON.stringify(memberRecord)).not.toContain('memberPrivateSecret')
	expect(JSON.stringify(memberRecord)).not.toContain('super-secret-value')

	await page.goto('/admin/usage')
	await expect(page.getByRole('heading', { name: 'Admin usage' })).toBeVisible()
	await expect(page.getByText('Unable to load admin usage.')).toHaveCount(0)
	await expect(page.getByText('Current month usage')).toBeVisible()
	await expect(page.getByText('memberPrivateSecret')).toHaveCount(0)
	await expect(page.getByText('super-secret-value')).toHaveCount(0)
	const usageApiResponse = await page.request.get(
		'/admin/usage.json?pageSize=100',
	)
	expect(usageApiResponse.ok()).toBe(true)
	const usagePayload = await usageApiResponse.json()
	expect(usagePayload.ok).toBe(true)
	expect(JSON.stringify(usagePayload)).not.toContain('memberPrivateSecret')
	expect(JSON.stringify(usagePayload)).not.toContain('super-secret-value')

	await page.goto(`/admin/users?pageSize=100&page=${lastUsersPage}`)
	await page.getByRole('button', { name: memberUser.username }).click()
	await expect(page.getByText('Account metadata only')).toBeVisible()

	const roleSelect = page.getByLabel('Role')
	await roleSelect.selectOption('admin')
	await page.getByRole('button', { name: 'Assign', exact: true }).click()
	await expect(page.getByText('Assigned admin role.')).toBeVisible()

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
