import {
	expect,
	test,
	type Page,
	waitForClientHydration,
} from './playwright-utils.ts'

async function openSwitcher(page: Page) {
	const trigger = page.getByTestId('org-switcher')
	const panel = page.getByTestId('org-switcher-panel')
	await trigger.click()
	await expect(panel).toBeVisible()
	await expect(trigger).toHaveAttribute('aria-expanded', 'true')
	await expect
		.poll(() => panel.evaluate((node) => getComputedStyle(node).opacity))
		.toBe('1')
	return { trigger, panel }
}

test('org switcher opens under its trigger, lists orgs, and closes like a menu', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `org-switcher-${runId}@example.com`,
		username: `org-switcher-${runId}`,
		password: 'org-switcher-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	// Create a second organization through the form; the handle follows the name.
	await page.setViewportSize({ width: 1440, height: 900 })
	await page.goto('/account/organizations/new')
	await waitForClientHydration(page)
	await page.getByLabel('Name').fill(`Pinned ${runId}`)
	await expect(page.getByLabel('Handle')).toHaveValue(`pinned-${runId}`)
	await page
		.getByRole('button', { name: 'Create organization', exact: true })
		.click()
	await expect(page.getByTestId('create-organization-confirm')).toContainText(
		`kody.codes/@pinned-${runId}`,
	)
	await page.getByRole('button', { name: 'Yes, create organization' }).click()
	await expect(page).toHaveURL(new RegExp(`/@pinned-${runId}$`))
	await expect(
		page.getByRole('heading', { level: 1, name: `Pinned ${runId}` }),
	).toBeVisible()
	await expect(page.getByTestId('org-home')).toBeVisible()
	await waitForClientHydration(page)

	const wide = await openSwitcher(page)
	await expect(
		wide.panel.getByTestId(`org-switcher-pinned-${runId}`),
	).toHaveAttribute('aria-current', 'true')
	await expect(
		wide.panel.getByTestId(`org-switcher-${user.username}`),
	).not.toHaveAttribute('aria-current', 'true')
	await expect(wide.panel.getByTestId('org-switcher-create')).toBeVisible()
	await expect(page.getByTestId('org-home-nav-workspace')).toHaveAttribute(
		'href',
		`/@pinned-${runId}/-/repositories`,
	)
	// No invites waiting, so no Invites row. The person's own links live in
	// the account menu, not the org switcher.
	await expect(wide.panel.getByTestId('org-switcher-invites')).toHaveCount(0)
	await expect(wide.panel.getByTestId('org-switcher-logout')).toHaveCount(0)
	await page.keyboard.press('Escape')
	await expect(wide.panel).toBeHidden()
	const accountMenu = page.getByTestId('account-menu')
	await accountMenu.click()
	const accountPanel = page.getByTestId('account-menu-panel')
	await expect(accountPanel).toBeVisible()
	const accountGroup = accountPanel.getByRole('group', {
		name: 'Your account',
	})
	await expect(
		accountGroup.getByRole('link', { name: 'Your profile' }),
	).toHaveAttribute('href', `/@${user.username}`)
	await expect(
		accountGroup.getByRole('link', { name: 'Account settings' }),
	).toHaveAttribute('href', '/account')
	// Usage follows the URL org (team home here), not a last-used cookie.
	await expect(
		accountGroup.getByRole('link', { name: 'Usage & credits' }),
	).toHaveAttribute('href', `/@pinned-${runId}/-/usage`)
	await expect(
		accountGroup.getByRole('button', { name: 'Log out' }),
	).toBeVisible()
	// Manage leads with the current workspace's Overview, then every other
	// workspace, so the avatar menu is never a dead end for org sections.
	const manageGroup = accountPanel.getByRole('group', { name: 'Manage' })
	const manageLinks = manageGroup.getByRole('link')
	await expect(manageLinks).toHaveCount(2)
	await expect(manageLinks.nth(0)).toHaveAccessibleName(
		`Overview @pinned-${runId}`,
	)
	await expect(manageLinks.nth(0)).toHaveAttribute('href', `/@pinned-${runId}`)
	await expect(manageLinks.nth(1)).toHaveAccessibleName(`@${user.username}`)
	await expect(manageLinks.nth(1)).toHaveAttribute(
		'href',
		`/@${user.username}/-/overview`,
	)
	await page.keyboard.press('Escape')
	await expect(accountPanel).toBeHidden()
	await openSwitcher(page)

	// Arrow keys walk the rows; Escape closes and returns focus to the trigger.
	await wide.trigger.focus()
	await page.keyboard.press('ArrowDown')
	await expect(
		wide.panel.getByTestId(`org-switcher-${user.username}`),
	).toBeFocused()
	await page.keyboard.press('End')
	await expect(wide.panel.getByTestId('org-switcher-create')).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(wide.panel).toBeHidden()
	await expect(wide.trigger).toBeFocused()
	await expect(wide.trigger).toHaveAttribute('aria-expanded', 'false')

	// A narrower desktop still opens the menu; a click outside closes it.
	await page.setViewportSize({ width: 860, height: 800 })
	const narrow = await openSwitcher(page)
	await page.mouse.click(20, 700)
	await expect(narrow.panel).toBeHidden()

	// Team settings chrome must name the URL org (not the personal org) next
	// to Delete organization.
	await page.setViewportSize({ width: 1440, height: 900 })
	await page.goto(`/@pinned-${runId}/-/settings`)
	await waitForClientHydration(page)
	// Team workspace rail matches the personal shape: same resource sections
	// (Credentials, Agents, …) plus Members, Settings, and Billing.
	const teamRail = page.getByRole('navigation', { name: 'Workspace sections' })
	for (const label of [
		'Overview',
		'Repositories',
		'Jobs',
		'Webhooks',
		'Credentials',
		'Secret providers',
		'Agents',
		'Memories',
		'Email',
		'Activity',
		'Members',
		'Settings',
		'Billing',
	] as const) {
		await expect(
			teamRail.getByRole('link', { name: label, exact: true }),
		).toBeVisible()
	}
	await expect(
		teamRail.getByRole('link', { name: 'Overview', exact: true }),
	).toHaveAttribute('href', `/@pinned-${runId}`)
	await expect(
		teamRail.getByRole('link', { name: 'Credentials', exact: true }),
	).toHaveAttribute('href', `/@pinned-${runId}/-/credentials`)
	await expect(page.getByTestId('org-switcher')).toHaveAccessibleName(
		`@pinned-${runId}: switch organization`,
	)
	await expect(
		page.getByLabel('Workspace sections').getByText(`@pinned-${runId}`),
	).toBeVisible()
	await expect(page.getByTestId('delete-org')).toBeVisible()

	// Teams, Collaborators, and Grants are tabs on Members.
	await teamRail.getByRole('link', { name: 'Members', exact: true }).click()
	await expect(page).toHaveURL(new RegExp(`/@pinned-${runId}/-/members$`))
	const memberTabs = page.getByRole('navigation', { name: 'Members pages' })
	for (const label of ['Members', 'Teams', 'Collaborators', 'Grants']) {
		await expect(
			memberTabs.getByRole('link', { name: label, exact: true }),
		).toBeVisible()
	}
	await memberTabs.getByRole('link', { name: 'Grants', exact: true }).click()
	await expect(page).toHaveURL(new RegExp(`/@pinned-${runId}/-/grants$`))
	await expect(
		teamRail.getByRole('link', { name: 'Members', exact: true }),
	).toHaveAttribute('aria-current', 'page')

	// Team orgs own their credentials, jobs, agents, and repositories, so the
	// rail opens each of them on the team org.
	const rail = page.getByRole('navigation', { name: 'Workspace sections' })
	await rail.getByRole('link', { name: 'Credentials', exact: true }).click()
	await expect(page).toHaveURL(new RegExp(`/@pinned-${runId}/-/credentials$`))
	await expect(
		page.getByRole('heading', { level: 1, name: 'Credentials' }),
	).toBeVisible()
	await expect(
		rail.getByRole('link', { name: 'Credentials', exact: true }),
	).toHaveAttribute('aria-current', 'page')
	await rail.getByRole('link', { name: 'Jobs', exact: true }).click()
	await expect(page).toHaveURL(new RegExp(`/@pinned-${runId}/-/jobs$`))
	await expect(
		page.getByRole('heading', { level: 1, name: 'Jobs' }),
	).toBeVisible()
	await expect(
		rail.getByRole('link', { name: 'Jobs', exact: true }),
	).toHaveAttribute('aria-current', 'page')
	await expect(
		rail.getByRole('link', { name: 'Settings', exact: true }),
	).not.toHaveAttribute('aria-current', 'page')

	// Agents lists only agents approved for the team org (none yet).
	await rail.getByRole('link', { name: 'Agents', exact: true }).click()
	await expect(page).toHaveURL(new RegExp(`/@pinned-${runId}/-/agents$`))
	await expect(
		page.getByRole('region', { name: 'Connected agents' }),
	).toBeVisible()
	await expect(
		rail.getByRole('link', { name: 'Agents', exact: true }),
	).toHaveAttribute('aria-current', 'page')
	await expect(page.getByTestId('not-found-page')).toHaveCount(0)

	// Repositories list what the team org owns (nothing yet).
	await rail.getByRole('link', { name: 'Repositories', exact: true }).click()
	await expect(page).toHaveURL(new RegExp(`/@pinned-${runId}/-/repositories$`))
	await expect(page.getByTestId('workspace-repositories')).toBeVisible()
	await expect(page.getByTestId('profile-packages-empty')).toBeVisible()
	await expect(
		rail.getByRole('link', { name: 'Repositories', exact: true }),
	).toHaveAttribute('aria-current', 'page')
	await expect(page.getByTestId('not-found-page')).toHaveCount(0)

	// A full load of each team page is a 200, not the old 404.
	for (const section of ['agents', 'repositories']) {
		const response = await page.goto(`/@pinned-${runId}/-/${section}`)
		expect(response?.status(), section).toBe(200)
	}
	const legacyConnections = await page.goto(
		`/@pinned-${runId}/-/connections/new?q=legacy`,
	)
	expect(legacyConnections?.status(), 'legacy /-/connections').toBe(200)
	await expect(page).toHaveURL(
		new RegExp(`/@pinned-${runId}/-/agents/new\\?q=legacy$`),
	)
	const legacy = await page.goto(`/@pinned-${runId}/-/packages?q=legacy`)
	expect(legacy?.status(), 'legacy /-/packages').toBe(200)
	await expect(page).toHaveURL(
		new RegExp(`/@pinned-${runId}/-/repositories\\?q=legacy$`),
	)
})

test('switching orgs from Credentials loads the destination org, not the one you left', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `org-switch-secrets-${runId}@example.com`,
		username: `org-switch-secrets-${runId}`,
		password: 'org-switch-secrets-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	const saved = await page.request.post('/account/secrets.json', {
		data: {
			action: 'save',
			name: 'personalOnlySecret',
			scope: 'user',
			value: 'personal-secret-value',
			allowedHosts: [],
			allowedPackages: [],
		},
		headers: { 'Content-Type': 'application/json' },
	})
	expect(saved.ok()).toBe(true)

	await page.setViewportSize({ width: 1440, height: 900 })
	await page.goto('/account/organizations/new')
	await waitForClientHydration(page)
	await page.getByLabel('Name').fill(`Switch ${runId}`)
	await expect(page.getByLabel('Handle')).toHaveValue(`switch-${runId}`)
	await page
		.getByRole('button', { name: 'Create organization', exact: true })
		.click()
	await page.getByRole('button', { name: 'Yes, create organization' }).click()
	await expect(page).toHaveURL(new RegExp(`/@switch-${runId}$`))

	await page.goto(`/@${user.username}/-/credentials`)
	await waitForClientHydration(page)
	await expect(page.getByText('personalOnlySecret')).toBeVisible()

	// The router runs the loader before it commits the URL, so the fetch must
	// name the team page itself or the server binds the personal org.
	const teamLoad = page.waitForRequest(
		(request) =>
			new URL(request.url()).pathname === '/account/credentials.json' &&
			request.method() === 'GET',
	)
	const { panel } = await openSwitcher(page)
	await panel.getByTestId(`org-switcher-switch-${runId}`).click()
	await expect(page).toHaveURL(new RegExp(`/@switch-${runId}/-/credentials$`))
	expect((await teamLoad).headers()['referer']).toMatch(
		new RegExp(`/@switch-${runId}/-/credentials$`),
	)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Credentials' }),
	).toBeVisible()
	await expect(
		page.getByText('No credentials yet.', { exact: false }),
	).toBeVisible()
	await expect(page.getByText('personalOnlySecret')).toHaveCount(0)
})

test('the switcher keeps each org section and loads it with the destination page as Referer', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `org-sections-${runId}@example.com`,
		username: `org-sections-${runId}`,
		password: 'org-switch-sections-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.setViewportSize({ width: 1440, height: 900 })
	await page.goto('/account/organizations/new')
	await waitForClientHydration(page)
	await page.getByLabel('Name').fill(`Sections ${runId}`)
	await expect(page.getByLabel('Handle')).toHaveValue(`sections-${runId}`)
	await page
		.getByRole('button', { name: 'Create organization', exact: true })
		.click()
	await page.getByRole('button', { name: 'Yes, create organization' }).click()
	await expect(page).toHaveURL(new RegExp(`/@sections-${runId}$`))

	// The switcher keeps the section. The router runs the loader before it
	// commits the URL, so the fetch must still name the team page.
	for (const section of [
		'memories',
		'workflows',
		'webhooks',
		'credentials',
		'values',
	]) {
		await page.goto(`/@${user.username}/-/${section}`)
		await waitForClientHydration(page)
		const destination = `/@sections-${runId}/-/${section}`
		const teamLoad = page.waitForRequest(
			(request) =>
				new URL(request.url()).pathname === `/account/${section}.json` &&
				request.method() === 'GET',
		)
		const { panel } = await openSwitcher(page)
		const teamRow = panel.getByTestId(`org-switcher-sections-${runId}`)
		await expect(teamRow).toHaveAttribute('href', destination)
		await teamRow.click()
		await expect(page).toHaveURL(new RegExp(`${destination}$`))
		expect((await teamLoad).headers()['referer']).toMatch(
			new RegExp(`${destination}$`),
		)
	}
})
