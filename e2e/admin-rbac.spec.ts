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
	const memberUsageResponse = await page.request.get(
		'/admin/users/usage.json?userId=1',
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
			'plan',
			'roles',
			'updated_at',
			'username',
		].sort(),
	)
	expect(memberRecord.plan).toBe(null)
	expect(JSON.stringify(memberRecord)).not.toContain('memberPrivateSecret')
	expect(JSON.stringify(memberRecord)).not.toContain('super-secret-value')

	// The usage drill-down lives on the users page and loads for the
	// selected account only.
	await page.goto(`/admin/users?pageSize=100&page=${lastUsersPage}`)
	await page.getByRole('button', { name: memberUser.username }).click()
	await expect(page.getByText('Usage & quotas')).toBeVisible()
	await expect(
		page.getByText('Unable to load usage for this account.'),
	).toHaveCount(0)
	await expect(
		page.getByRole('heading', { name: 'Entitlements' }),
	).toBeVisible()
	await expect(page.getByText('memberPrivateSecret')).toHaveCount(0)
	await expect(page.getByText('super-secret-value')).toHaveCount(0)
	const memberId = Number(memberRecord.id)
	const usageApiResponse = await page.request.get(
		`/admin/users/usage.json?userId=${memberId}`,
	)
	expect(usageApiResponse.ok()).toBe(true)
	const usagePayload = await usageApiResponse.json()
	expect(usagePayload.ok).toBe(true)
	expect(usagePayload.userId).toBe(memberId)
	expect(JSON.stringify(usagePayload)).not.toContain('memberPrivateSecret')
	expect(JSON.stringify(usagePayload)).not.toContain('super-secret-value')
	expect(JSON.stringify(usagePayload)).not.toContain(memberUser.email)

	await page.goto('/admin/insights')
	await expect(
		page.getByRole('heading', { name: 'Admin insights' }),
	).toBeVisible()
	await expect(page.getByText('Unable to load admin insights.')).toHaveCount(0)
	await expect(page.getByRole('heading', { name: 'User growth' })).toBeVisible()
	await expect(
		page.getByRole('img', { name: 'Cumulative registered users per week' }),
	).toBeVisible()
	const insightsApiResponse = await page.request.get('/admin/insights.json')
	expect(insightsApiResponse.ok()).toBe(true)
	const insightsPayload = await insightsApiResponse.json()
	expect(insightsPayload.ok).toBe(true)
	expect(JSON.stringify(insightsPayload)).not.toContain('memberPrivateSecret')
	expect(JSON.stringify(insightsPayload)).not.toContain('super-secret-value')
	expect(JSON.stringify(insightsPayload)).not.toContain(memberUser.email)

	await page.goto(`/admin/users?pageSize=100&page=${lastUsersPage}`)
	await page.getByRole('button', { name: memberUser.username }).click()
	await expect(page.getByText('Account metadata only')).toBeVisible()

	const planSelect = page.getByLabel('Plan')
	await expect(planSelect).toHaveValue('')
	await planSelect.selectOption('pro')
	await page.getByRole('button', { name: 'Save plan' }).click()
	await expect(page.getByText('Updated plan to pro.')).toBeVisible()
	const planApiResponse = await page.request.get(
		`/admin/users.json?pageSize=100&page=${lastUsersPage}`,
	)
	expect(planApiResponse.ok()).toBe(true)
	const planPayload = await planApiResponse.json()
	const memberAfterPlan = planPayload.users.find(
		(user: { email: string }) => user.email === memberUser.email,
	)
	expect(memberAfterPlan.plan).toBe('pro')

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
