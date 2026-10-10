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
	const manageGroup = wide.panel.getByTestId('org-switcher-manage-group')
	await expect(manageGroup).toBeVisible()
	await expect(
		manageGroup.getByRole('link', { name: 'Settings' }),
	).toHaveAttribute('href', `/@pinned-${runId}/-/settings`)
	await expect(
		manageGroup.getByRole('link', { name: 'Members' }),
	).toHaveAttribute('href', `/@pinned-${runId}/-/members`)
	await expect(
		manageGroup.getByRole('link', { name: 'Teams' }),
	).toHaveAttribute('href', `/@pinned-${runId}/-/teams`)
	// No invites waiting, so no Invites row; the person's own links follow.
	await expect(wide.panel.getByTestId('org-switcher-invites')).toHaveCount(0)
	const accountGroup = wide.panel.getByRole('group', { name: 'Your account' })
	await expect(
		accountGroup.getByRole('link', { name: 'Your profile' }),
	).toHaveAttribute('href', `/@${user.username}`)
	await expect(
		accountGroup.getByRole('link', { name: 'Account settings' }),
	).toHaveAttribute('href', '/account')
	await expect(
		accountGroup.getByRole('button', { name: 'Log out' }),
	).toBeVisible()

	// Arrow keys walk the rows; Escape closes and returns focus to the trigger.
	await wide.trigger.focus()
	await page.keyboard.press('ArrowDown')
	await expect(
		wide.panel.getByTestId(`org-switcher-${user.username}`),
	).toBeFocused()
	await page.keyboard.press('End')
	await expect(wide.panel.getByTestId('org-switcher-logout')).toBeFocused()
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
	await expect(page.getByTestId('org-switcher')).toHaveAccessibleName(
		`@pinned-${runId}: organizations, manage, and account`,
	)
	await expect(
		page.getByLabel('Workspace sections').getByText(`@pinned-${runId}`),
	).toBeVisible()
	await expect(page.getByTestId('delete-org')).toBeVisible()

	// Team orgs own their secrets, jobs, connections, and repositories, so the
	// rail opens each of them on the team org.
	const rail = page.getByRole('navigation', { name: 'Workspace sections' })
	await rail.getByRole('link', { name: 'Secrets', exact: true }).click()
	await expect(page).toHaveURL(new RegExp(`/@pinned-${runId}/-/secrets$`))
	await expect(
		page.getByRole('heading', { level: 1, name: 'Secrets' }),
	).toBeVisible()
	await expect(
		rail.getByRole('link', { name: 'Secrets', exact: true }),
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

	// Connections list only agents approved for the team org (none yet).
	await rail.getByRole('link', { name: 'Connections', exact: true }).click()
	await expect(page).toHaveURL(new RegExp(`/@pinned-${runId}/-/connections$`))
	await expect(
		page.getByRole('region', { name: 'Connected agents' }),
	).toBeVisible()
	await expect(
		rail.getByRole('link', { name: 'Connections', exact: true }),
	).toHaveAttribute('aria-current', 'page')
	await expect(page.getByTestId('not-found-page')).toHaveCount(0)

	// Repositories list what the team org owns (nothing yet).
	await rail.getByRole('link', { name: 'Repositories', exact: true }).click()
	await expect(page).toHaveURL(new RegExp(`/@pinned-${runId}/-/packages$`))
	await expect(page.getByTestId('workspace-repositories')).toBeVisible()
	await expect(page.getByTestId('profile-packages-empty')).toBeVisible()
	await expect(
		rail.getByRole('link', { name: 'Repositories', exact: true }),
	).toHaveAttribute('aria-current', 'page')
	await expect(page.getByTestId('not-found-page')).toHaveCount(0)

	// A full load of each team page is a 200, not the old 404.
	for (const section of ['connections', 'packages']) {
		const response = await page.goto(`/@pinned-${runId}/-/${section}`)
		expect(response?.status(), section).toBe(200)
	}
})

test('switching orgs from Secrets loads the destination org, not the one you left', async ({
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

	await page.goto(`/@${user.username}/-/secrets`)
	await waitForClientHydration(page)
	await expect(page.getByText('personalOnlySecret')).toBeVisible()

	// The router runs the loader before it commits the URL, so the fetch must
	// name the team page itself or the server binds the personal org.
	const teamLoad = page.waitForRequest(
		(request) =>
			new URL(request.url()).pathname === '/account/secrets.json' &&
			request.method() === 'GET',
	)
	const { panel } = await openSwitcher(page)
	await panel.getByTestId(`org-switcher-switch-${runId}`).click()
	await expect(page).toHaveURL(new RegExp(`/@switch-${runId}/-/secrets$`))
	expect((await teamLoad).headers()['referer']).toMatch(
		new RegExp(`/@switch-${runId}/-/secrets$`),
	)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Secrets' }),
	).toBeVisible()
	await expect(
		page.getByText('No secrets yet.', { exact: false }),
	).toBeVisible()
	await expect(page.getByText('personalOnlySecret')).toHaveCount(0)
})
