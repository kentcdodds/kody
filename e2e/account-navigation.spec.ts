import {
	collectJsonRequests,
	expectSingleCommitTransition,
	observeMainTransitions,
	readMainTransitions,
} from './main-transitions.ts'
import {
	expect,
	test,
	type Locator,
	type Page,
	waitForClientHydration,
} from './playwright-utils.ts'

/**
 * Account and admin pages sit in a persistent shell; moving between them is
 * tab switching. Each hop must replace the previous page in one commit: the
 * heading never disappears, no "Loading…" copy takes the content's place,
 * and the destination payload the router preloaded is never fetched twice.
 */
async function clickThroughSections(
	page: Page,
	navName: string,
	hops: Array<{ link: string; heading: string | RegExp }>,
	fromHeading: string | RegExp,
) {
	const requests = collectJsonRequests(page)
	let previousHeading = fromHeading
	for (const hop of hops) {
		requests.reset()
		await observeMainTransitions(page)
		await page
			.getByRole('navigation', { name: navName })
			.getByRole('link', { name: hop.link, exact: true })
			.click()
		await expect(
			page.getByRole('heading', { level: 1, name: hop.heading }),
		).toBeVisible()
		// Let any stray follow-up render land before reading the log.
		await page.waitForTimeout(250)
		expectSingleCommitTransition(await readMainTransitions(page), {
			fromHeading: previousHeading,
			toHeading: hop.heading,
		})
		expect(requests.duplicates(), requests.paths.join(', ')).toEqual([])
		previousHeading = hop.heading
	}
}

test('account section switches keep the current page on screen (no loading flash, no refetch)', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `account-nav-${runId}@example.com`,
		username: `account-nav-${runId}`,
		password: 'account-nav-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.goto('/account/jobs')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Jobs' }),
	).toBeVisible()

	await clickThroughSections(
		page,
		'Account sections',
		[
			{ link: 'Memories', heading: 'Memories' },
			{ link: 'Secrets', heading: 'Secrets' },
			{ link: 'Connections', heading: 'Connections' },
			{ link: 'Workflows', heading: 'Workflows' },
			{ link: 'Overview', heading: 'Account' },
			{ link: 'Jobs', heading: 'Jobs' },
		],
		'Jobs',
	)

	// Packages sits in the rail at the same level as the other sections and
	// points at the profile, which is the canonical package list.
	await expect(
		page
			.getByRole('navigation', { name: 'Account sections' })
			.getByRole('link', { name: 'Packages', exact: true }),
	).toHaveAttribute('href', `/@${user.username}`)
})

test('Add connection opens the full client wall and a host step without refetching the connections payload', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `connections-${runId}@example.com`,
		username: `connections-${runId}`,
		password: 'connections-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.goto('/account/connections')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Connections' }),
	).toBeVisible()

	const requests = collectJsonRequests(page)
	await observeMainTransitions(page)
	await page.getByTestId('account-connections-add').click()
	await expect(page).toHaveURL(/\/account\/connections\/new$/)
	const grid = page.getByTestId('account-connections-agent-grid')
	await expect(grid).toBeVisible()
	// The heading never leaves the screen: the grid is a view of the same page.
	await page.waitForTimeout(250)
	expectSingleCommitTransition(await readMainTransitions(page), {
		fromHeading: 'Connections',
		toHeading: 'Connections',
	})
	expect(requests.duplicates(), requests.paths.join(', ')).toEqual([])
	requests.reset()
	// Every named client is a card and none is greyed or hidden by viewport.
	await expect(grid.getByRole('link')).toHaveCount(14)
	await expect(grid.locator('[data-greyed="true"]')).toHaveCount(0)
	await expect(page.getByTestId('onboarding-agent-claude-code')).toBeVisible()
	await expect(page.getByTestId('onboarding-agent-grok')).toBeVisible()

	await page.getByTestId('onboarding-agent-claude-code').click()
	await expect(page).toHaveURL(/\/account\/connections\/new\/claude-code$/)
	await expect(
		page.getByRole('heading', { level: 2, name: 'Connect Claude Code' }),
	).toBeVisible()
	await expect(
		page.getByTestId('account-connections-agent-instructions'),
	).toBeVisible()
	// Connections stays current in the rail on the nested views.
	await expect(
		page
			.getByRole('navigation', { name: 'Account sections' })
			.getByRole('link', { name: 'Connections', exact: true }),
	).toHaveAttribute('aria-current', 'page')

	expect(requests.duplicates(), requests.paths.join(', ')).toEqual([])
	requests.reset()

	await page.getByTestId('account-connections-change-agent').click()
	await expect(grid).toBeVisible()
	expect(requests.duplicates(), requests.paths.join(', ')).toEqual([])
})

async function markSearchNode(search: Locator) {
	await search.evaluate((element) => {
		;(element as HTMLElement).dataset.kodySearchMount = '1'
	})
}

test('account live search keeps the same focused input while the list filters', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `account-search-${runId}@example.com`,
		username: `account-search-${runId}`,
		password: 'account-search-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })

	const alphaSecret = await page.request.post('/account/secrets.json', {
		data: {
			action: 'save',
			name: `alphaSecret${runId}`,
			scope: 'user',
			value: 'alpha-secret-value',
			description: 'Matches the alpha query',
			allowedHosts: ['api.example.com'],
			allowedPackages: [],
		},
		headers: { 'Content-Type': 'application/json' },
	})
	expect(alphaSecret.ok()).toBe(true)
	const betaSecret = await page.request.post('/account/secrets.json', {
		data: {
			action: 'save',
			name: `betaSecret${runId}`,
			scope: 'user',
			value: 'beta-secret-value',
			description: 'Does not match the alpha query',
			allowedHosts: ['api.example.com'],
			allowedPackages: [],
		},
		headers: { 'Content-Type': 'application/json' },
	})
	expect(betaSecret.ok()).toBe(true)

	await page.goto('/account/secrets')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Secrets' }),
	).toBeVisible()
	await expect(page.getByText(`alphaSecret${runId}`)).toBeVisible()
	await expect(page.getByText(`betaSecret${runId}`)).toBeVisible()

	const secretsSearch = page.getByRole('searchbox', { name: 'Search secrets' })
	await secretsSearch.click()
	await markSearchNode(secretsSearch)
	await secretsSearch.pressSequentially(`alphaSecret${runId}`, { delay: 20 })
	await expect(secretsSearch).toBeFocused()
	await expect(secretsSearch).toHaveAttribute('data-kody-search-mount', '1')
	await expect(secretsSearch).toHaveValue(`alphaSecret${runId}`)
	await expect(page.getByText(`alphaSecret${runId}`)).toBeVisible()
	await expect(page.getByText(`betaSecret${runId}`)).toHaveCount(0)

	await page.goto('/account/jobs')
	await waitForClientHydration(page)
	const jobsSearch = page.getByRole('searchbox', { name: 'Search jobs' })
	await jobsSearch.click()
	await markSearchNode(jobsSearch)
	await jobsSearch.pressSequentially('no-such-job', { delay: 20 })
	await expect(jobsSearch).toBeFocused()
	await expect(jobsSearch).toHaveAttribute('data-kody-search-mount', '1')
	await expect(jobsSearch).toHaveValue('no-such-job')
})

test('admin section switches keep the current page on screen (no loading flash, no refetch)', async ({
	page,
	seedE2eUser,
	assignRole,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const adminUser = await seedE2eUser({
		email: `admin-nav-${runId}@example.com`,
		username: `admin-nav-${runId}`,
		password: 'admin-nav-password',
	})
	await assignRole(adminUser.email, 'admin')
	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto('/admin/roles')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Admin roles' }),
	).toBeVisible()

	await clickThroughSections(
		page,
		'Admin sections',
		[
			{ link: 'Reserved usernames', heading: 'Reserved usernames' },
			{ link: 'Feature flags', heading: 'Admin feature flags' },
			{ link: 'Roles', heading: 'Admin roles' },
		],
		'Admin roles',
	)
})
