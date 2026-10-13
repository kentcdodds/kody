import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('Credentials lists a key, filters by kind, and opens its detail pane without the value', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `credentials-${runId}@example.com`,
		username: `credentials-${runId}`,
		password: 'credentials-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	const value = `sk-never-shown-${runId}`
	const saved = await page.request.post('/account/secrets.json', {
		data: {
			action: 'save',
			name: 'DEMO_API_KEY',
			scope: 'user',
			value,
			description: 'Demo key',
			allowedHosts: ['api.example.com'],
			allowedPackages: [],
		},
		headers: { 'Content-Type': 'application/json' },
	})
	expect(saved.ok()).toBe(true)

	await page.setViewportSize({ width: 1440, height: 900 })
	await page.goto(`/@${user.username}/-/credentials`)
	await waitForClientHydration(page)
	const table = page.getByRole('region', { name: 'Credentials', exact: true })
	const row = table.getByRole('link', { name: /DEMO_API_KEY/ })
	await expect(row).toBeVisible()
	const addCredential = page.getByRole('link', { name: 'Add credential' })
	await expect(addCredential).toHaveAttribute(
		'href',
		`/@${user.username}/-/credentials/new`,
	)
	await expect(
		addCredential
			.locator('xpath=..')
			.getByRole('link', { name: 'Secret providers' }),
	).toHaveAttribute('href', `/@${user.username}/-/secret-providers`)

	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.selectOption('oauth')
	await expect(page).toHaveURL(/\/credentials\?kind=oauth$/)
	await expect(row).toHaveCount(0)
	await page
		.getByRole('combobox', { name: 'Filter credentials by kind' })
		.selectOption('secret')
	await expect(row).toBeVisible()

	await row.click()
	await expect(page).toHaveURL(
		new RegExp(`/@${user.username}/-/credentials/[^/?]+\\?kind=secret$`),
	)
	const pane = page.getByRole('region', { name: 'DEMO_API_KEY details' })
	await expect(pane.getByText('{{secret:DEMO_API_KEY}}')).toBeVisible()
	await expect(pane.getByText('api.example.com')).toBeVisible()
	await expect(pane.getByText('Authorization: Bearer {value}')).toBeVisible()
	await expect(pane.getByRole('link', { name: 'Edit' })).toHaveAttribute(
		'href',
		`/@${user.username}/-/secrets/user/DEMO_API_KEY`,
	)
	await expect(page.getByText(value)).toHaveCount(0)

	// The open row collapses back to the list, keeping the filter.
	await row.click()
	await expect(page).toHaveURL(
		new RegExp(`/@${user.username}/-/credentials\\?kind=secret$`),
	)
	await expect(pane).toHaveCount(0)

	// The indexes Credentials folds together redirect to it, filtered.
	for (const [section, landing] of [
		['secrets', '/credentials?kind=secret'],
		['integrations', '/credentials?kind=oauth'],
		['mcp-servers', '/credentials?kind=mcp'],
		['secret-providers', '/secret-providers'],
	] as const) {
		const response = await page.goto(`/@${user.username}/-/${section}`)
		expect(response?.status(), section).toBe(200)
		expect(page.url(), section).toMatch(
			new RegExp(`/@${user.username}/-${landing.replace('?', '\\?')}$`),
		)
	}

	await page.goto(`/@${user.username}/-/credentials/does-not-exist`)
	await waitForClientHydration(page)
	await expect(
		page
			.getByTestId('credentials-error')
			.getByRole('button', { name: 'Copy prompt for your agent' }),
	).toBeVisible()
})

test('the creation link saves Key, URL, and login credentials from their prefill', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `credential-link-${runId}@example.com`,
		username: `credential-link-${runId}`,
		password: 'credential-link-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	const value = `re-never-shown-${runId}`

	await page.goto(
		'/connect/credential?kind=secret&kindMode=required&name=DIGEST_KEY&provider=resend&allowedHosts=api.resend.com&forPackage=pr-digest&need=email',
	)
	await waitForClientHydration(page)
	// The org-less link opens the signup org's creation page, query intact.
	await expect(page).toHaveURL(
		new RegExp(
			`/@${user.username}/-/credentials/new\\?kind=secret&kindMode=required&name=DIGEST_KEY&`,
		),
	)
	await expect(page.getByRole('heading', { name: 'Add a key' })).toBeVisible()
	await expect(
		page.getByText('This link asks for a Key credential.'),
	).toBeVisible()
	await expect(page.getByTestId('credential-kind-oauth')).toHaveCount(0)
	await expect(page.getByLabel('Name')).toHaveValue('DIGEST_KEY')
	await expect(page.getByLabel(/Allowed hosts/)).toHaveValue('api.resend.com')
	await page.getByRole('textbox', { name: 'Value' }).fill(value)
	await page.getByTestId('connect-credential-save').click()
	await expect(page.getByTestId('connect-credential-saved')).toContainText(
		'DIGEST_KEY is saved',
	)
	await expect(page.getByText(value)).toHaveCount(0)
	await expect(page.getByTestId('connect-credential-approve')).toHaveAttribute(
		'href',
		new RegExp(
			`^/@${user.username}/pr-digest/approve-credentials\\?mine%5Bemail%5D=id%3A[^&]+$`,
		),
	)

	await page.getByRole('link', { name: 'View credential' }).click()
	const pane = page.getByRole('region', { name: 'DIGEST_KEY details' })
	await expect(pane.getByText('api.resend.com')).toBeVisible()
	await expect(pane.getByText('resend', { exact: true })).toBeVisible()

	// A hinted kind can change; OAuth hands the prefill to /connect/oauth.
	await page.goto('/connect/credential?kind=secret&provider=github')
	await waitForClientHydration(page)
	await page.getByTestId('credential-kind-oauth').click()
	await expect(page).toHaveURL(
		new RegExp(
			`/@${user.username}/-/credentials/new\\?kind=oauth&provider=github$`,
		),
	)
	await expect(page.getByTestId('connect-credential-continue')).toHaveAttribute(
		'href',
		'/connect/oauth?kind=oauth&provider=github',
	)

	// A URL credential takes its hosts; a value off those hosts is refused
	// with a prompt the person can hand their agent.
	await page.goto(
		'/connect/credential?kind=url&kindMode=required&name=BOT_URL&allowedHosts=api.telegram.org',
	)
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { name: 'Add a URL credential' }),
	).toBeVisible()
	await expect(page.getByLabel(/^Hosts/)).toHaveValue('api.telegram.org')
	const urlValue = `https://api.telegram.org/bot${runId}:never-shown/sendMessage`
	await page
		.getByRole('textbox', { name: 'Value' })
		.fill('https://hooks.example.com/elsewhere')
	await page.getByTestId('connect-credential-save').click()
	await expect(page.getByTestId('connect-credential-message')).toContainText(
		'must be one of its hosts',
	)
	await expect(
		page.getByRole('button', { name: 'Copy prompt for your agent' }),
	).toBeVisible()
	await page.getByRole('textbox', { name: 'Value' }).fill(urlValue)
	await page.getByTestId('connect-credential-save').click()
	await expect(page.getByTestId('connect-credential-saved')).toContainText(
		'BOT_URL is saved',
	)
	await page.getByRole('link', { name: 'View credential' }).click()
	const urlPane = page.getByRole('region', { name: 'BOT_URL details' })
	await expect(urlPane.getByText('api.telegram.org')).toBeVisible()
	await expect(page.getByText(urlValue)).toHaveCount(0)

	// A login link carries its exchange, so the person types only the fields
	// the exchange body names.
	const exchange = {
		url: 'https://api.example.com/session',
		bodyFormat: 'json',
		body: { email: '{email}', password: '{password}' },
		tokenPath: 'data.token',
	}
	await page.goto(
		`/connect/credential?kind=login&name=SITE_LOGIN&allowedHosts=api.example.com&loginExchange=${encodeURIComponent(JSON.stringify(exchange))}`,
	)
	await waitForClientHydration(page)
	await expect(
		page.getByTestId('connect-credential-login-exchange'),
	).toContainText('api.example.com')
	await page.getByLabel('Email').fill('me@example.com')
	await page.getByRole('textbox', { name: 'Password' }).fill(`pw-${runId}`)
	await page.getByTestId('connect-credential-save').click()
	await expect(page.getByTestId('connect-credential-saved')).toContainText(
		'SITE_LOGIN is saved',
	)
})

test('the legacy secret intake link opens the Key form with its prefill', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `secret-set-${runId}@example.com`,
		username: `secret-set-${runId}`,
		password: 'secret-set-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	await page.goto(
		'/connect/secret-set?name=STRIPE_KEY&description=Billing&allowed-host=api.stripe.com&package=pkg-gone&expiresAt=2030-01-31',
	)
	await waitForClientHydration(page)
	await expect(page).toHaveURL(
		new RegExp(
			`/@${user.username}/-/credentials/new\\?kind=secret&name=STRIPE_KEY&`,
		),
	)
	await expect(page.getByRole('heading', { name: 'Add a key' })).toBeVisible()
	await expect(page.getByLabel('Name')).toHaveValue('STRIPE_KEY')
	await expect(page.getByLabel(/^Description/)).toHaveValue('Billing')
	await expect(page.getByLabel(/Allowed hosts/)).toHaveValue('api.stripe.com')
	await expect(page.getByLabel(/^Expires/)).toHaveValue('2030-01-31')
	const access = page.getByTestId('connect-credential-package-access')
	await expect(access).toContainText('pkg-gone')
	await expect(access).toContainText('(not found in this org)')
	await expect(access.getByRole('checkbox')).toBeChecked()

	// A package key for a package this org does not have cannot be saved.
	await page.goto(
		'/connect/secret-set?name=STRIPE_KEY&scope=package&packageId=pkg-gone',
	)
	await waitForClientHydration(page)
	await expect(page.getByTestId('connect-credential-link-problem')).toHaveText(
		'This link names a package that is not in this org.',
	)
	await expect(page.getByTestId('connect-credential-save')).toBeDisabled()
})
